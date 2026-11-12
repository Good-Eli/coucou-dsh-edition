// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::platform::{self, cursor_physical, left_button_down};

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible strip that wakes the island when it is hidden
/// and the closed island is set to show nothing.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Around the window, how far the cursor is still worth telling the page
/// about (Mochi's eyes follow it), in logical px. Past it the page hears once
/// that the cursor left, then nothing until it comes back: a cursor working in
/// another app costs neither messages nor island frames.
const NEAR_ZONE: f64 = 420.0;
/// The poll's period while the cursor is far from the island, in ms.
const FAR_PERIOD_MS: u64 = 50;

/// Whether a cursor at window-logical (x, y) is near a window of `size`.
fn is_near(x: f64, y: f64, size: (f64, f64)) -> bool {
    x >= -NEAR_ZONE && x <= size.0 + NEAR_ZONE && y >= -NEAR_ZONE && y <= size.1 + NEAR_ZONE
}

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    /// The window's logical size while collapsed: the closed island the page
    /// draws, or the wake strip.
    pub collapsed_size: Mutex<(f64, f64)>,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            collapsed_size: Mutex::new((STRIP_W, STRIP_H)),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    pub(crate) fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    /// Waits until the gate opens or `timeout` passes; true when it is open.
    pub(crate) fn wait_active_for(&self, timeout: Duration) -> bool {
        let guard = self.active.lock().unwrap();
        if *guard {
            return true;
        }
        let (guard, _) = self.cv.wait_timeout(guard, timeout).unwrap();
        *guard
    }

    pub(crate) fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}


pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// A display's logical origin, the key `at:<x>,<y>` preferences are matched on.
/// Names are no good for that: two monitors of the same model share one.
fn logical_origin(m: &Monitor) -> (i32, i32) {
    let scale = m.scale_factor();
    let p = m.position();
    ((p.x as f64 / scale).round() as i32, (p.y as f64 / scale).round() as i32)
}

/// One entry of the "Island lives on" list in Settings.
#[derive(Serialize, Clone)]
pub struct MonitorChoice {
    pub key: String,
    pub label: String,
}

pub fn monitor_choices(app: &AppHandle) -> Vec<MonitorChoice> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let d = describe(m);
            MonitorChoice {
                key: d.key(),
                label: crate::i18n::tf(
                    "{name} — {width}×{height} at {x},{y}",
                    &[
                        ("name", &d.name),
                        ("width", &d.w.to_string()),
                        ("height", &d.h.to_string()),
                        ("x", &d.x.to_string()),
                        ("y", &d.y.to_string()),
                    ],
                ),
            }
        })
        .collect()
}

/// What a display is remembered by: its logical origin, plus its name and
/// logical size, so it is still found after the layout is rearranged or the
/// resolution changes (the Mac keeps the display's UUID for the same reason;
/// Tauri has no stable ID).
#[derive(Debug, Clone, PartialEq)]
struct DisplayId {
    name: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl DisplayId {
    /// `at:<x>,<y>` stays first, so a preference saved before still matches.
    fn key(&self) -> String {
        format!("at:{},{}|{}|{}x{}", self.x, self.y, self.name.replace('|', " "), self.w, self.h)
    }
}

fn describe(m: &Monitor) -> DisplayId {
    let (x, y) = logical_origin(m);
    let scale = m.scale_factor();
    let s = m.size();
    DisplayId {
        name: m.name().cloned().unwrap_or_else(|| "Display".into()),
        x,
        y,
        w: (s.width as f64 / scale).round() as i32,
        h: (s.height as f64 / scale).round() as i32,
    }
}

/// Which display a saved `at:` preference points at, best match first: same
/// place and name; the same name and size elsewhere (layout rearranged); the
/// same name alone when unique (resolution changed); the same place. None
/// means unplugged, and the caller falls back to the primary display.
fn pick_display(pref: &str, displays: &[DisplayId]) -> Option<usize> {
    let rest = pref.strip_prefix("at:")?;
    let mut parts = rest.split('|');
    let (x, y) = parts.next()?.split_once(',')?;
    let (x, y) = (x.trim().parse::<i32>().ok()?, y.trim().parse::<i32>().ok()?);
    let name = parts.next();
    let size = parts.next().and_then(|s| {
        let (w, h) = s.split_once('x')?;
        Some((w.parse::<i32>().ok()?, h.parse::<i32>().ok()?))
    });
    let at = |d: &DisplayId| d.x == x && d.y == y;
    if let Some(name) = name {
        if let Some(i) = displays.iter().position(|d| at(d) && d.name == name) {
            return Some(i);
        }
        if let Some((w, h)) = size {
            if let Some(i) = displays.iter().position(|d| d.name == name && d.w == w && d.h == h) {
                return Some(i);
            }
        }
        let mut same_name = displays.iter().enumerate().filter(|(_, d)| d.name == name);
        if let (Some((i, _)), None) = (same_name.next(), same_name.next()) {
            return Some(i);
        }
    }
    displays.iter().position(at)
}

/// The display the island lives on: a chosen one, the primary one, or the one
/// under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    let ids: Vec<DisplayId> = monitors.iter().map(describe).collect();
    if let Some(i) = pick_display(pref, &ids) {
        return Some(monitors[i].clone());
    }
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

#[cfg(test)]
mod display_tests {
    use super::*;

    fn d(name: &str, x: i32, y: i32, w: i32, h: i32) -> DisplayId {
        DisplayId { name: name.into(), x, y, w, h }
    }

    #[test]
    fn a_display_is_found_again_after_changes() {
        let dell = d("DELL U2720Q", 1920, 0, 2560, 1440);
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let key = dell.key();
        assert_eq!(pick_display(&key, &[lap.clone(), dell.clone()]), Some(1));
        // Rearranged: the Dell moved to the left of the laptop.
        let moved = [d("eDP-1", 2560, 0, 1920, 1200), d("DELL U2720Q", 0, 0, 2560, 1440)];
        assert_eq!(pick_display(&key, &moved), Some(1));
        // Resolution changed, still the only Dell.
        let rescaled = [lap.clone(), d("DELL U2720Q", 1920, 0, 1920, 1080)];
        assert_eq!(pick_display(&key, &rescaled), Some(1));
        // Unplugged: nothing, so the caller falls back to the primary display.
        assert_eq!(pick_display(&key, &[lap.clone()]), None);
    }

    #[test]
    fn two_identical_monitors_are_told_apart_by_place() {
        let a = d("LG 27UL500", 0, 0, 1920, 1080);
        let b = d("LG 27UL500", 1920, 0, 1920, 1080);
        assert_eq!(pick_display(&b.key(), &[a.clone(), b.clone()]), Some(1));
        assert_eq!(pick_display(&a.key(), &[a, b]), Some(0));
    }

    #[test]
    fn preferences_saved_before_still_match() {
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let ext = d("HDMI-1", 1920, 0, 1920, 1080);
        assert_eq!(pick_display("at:1920,0", &[lap.clone(), ext.clone()]), Some(1));
        assert_eq!(pick_display("primary", &[lap, ext]), None);
        assert_eq!(pick_display("at:nonsense", &[]), None);
    }
}

/// Calculates the zoom correction factor so that 1 CSS pixel equals 1 window logical pixel.
/// If WebView2's devicePixelRatio differs from the window's scale factor (e.g. system text
/// scaling or multi-monitor DPI mismatch), adjusting the webview zoom ensures the island
/// canvas (PANEL_W / EXPANDED_W) fits within the window without clipping.
pub fn calculate_zoom_correction(current_zoom: f64, scale: f64, dpr: f64) -> Option<f64> {
    if dpr <= 0.0 || !dpr.is_finite() || scale <= 0.0 || !scale.is_finite() {
        return None;
    }
    if (dpr - scale).abs() / scale < 0.02 {
        return None;
    }
    let new_zoom = (current_zoom * (scale / dpr)).clamp(0.25, 4.0);
    Some(new_zoom)
}

#[cfg(test)]
mod zoom_tests {
    use super::*;

    #[test]
    fn zoom_correction_is_none_when_dpr_matches_window_scale() {
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.25, 1.25), None);
        // Within 2% threshold
        assert_eq!(calculate_zoom_correction(1.0, 1.0, 1.01), None);
    }

    #[test]
    fn zoom_correction_adjusts_for_dpi_mismatch() {
        // Issue #346: 100% scale display (scale 1.0) but WebView2 dpr = 1.25
        let zoom = calculate_zoom_correction(1.0, 1.0, 1.25);
        assert_eq!(zoom, Some(0.8));

        // 125% display with 125% text scale (dpr 1.5625 vs scale 1.25)
        let zoom = calculate_zoom_correction(1.0, 1.25, 1.5625);
        assert_eq!(zoom, Some(0.8));

        // 150% display with 100% webview dpr
        let zoom = calculate_zoom_correction(1.0, 1.5, 1.0);
        assert_eq!(zoom, Some(1.5));
    }

    #[test]
    fn only_a_cursor_near_the_island_is_followed() {
        let size = (PANEL_W, PANEL_H);
        assert!(is_near(360.0, 10.0, size));
        assert!(is_near(-400.0, PANEL_H + 400.0, size));
        assert!(!is_near(-500.0, 10.0, size));
        assert!(!is_near(360.0, PANEL_H + 900.0, size));
    }

    #[test]
    fn a_closed_island_stays_inside_the_panel() {
        assert_eq!(clamp_collapsed((160.0, 26.0)), (160.0, 26.0));
        assert_eq!(clamp_collapsed((5000.0, 900.0)), (PANEL_W, PANEL_H));
        assert_eq!(clamp_collapsed((0.0, -3.0)), (1.0, 1.0));
        assert_eq!(clamp_collapsed((f64::NAN, 26.0)), (PANEL_W, 26.0));
    }

    #[test]
    fn zoom_correction_handles_invalid_inputs() {
        assert_eq!(calculate_zoom_correction(1.0, 0.0, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, -1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, f64::NAN, 1.0), None);
        assert_eq!(calculate_zoom_correction(1.0, 1.0, f64::INFINITY), None);
    }

    #[test]
    fn a_top_taskbar_moves_the_island_down_and_nothing_else_does() {
        // Taskbar at the bottom (or none): the work area starts at the top.
        assert_eq!(top_inset_from(0, 0), 0);
        // A 48 px taskbar at the top of a display placed at y = -1080.
        assert_eq!(top_inset_from(-1080, -1032), 48);
        // Nonsense from the system never pushes the island off the display.
        assert_eq!(top_inset_from(0, -20), 0);
        assert_eq!(top_inset_from(0, 900), 0);
    }

    // ── Placement ────────────────────────────────────────────────────────────

    /// A 1920×1080 screen with a 40 px taskbar at the bottom.
    fn screen() -> Area {
        Area { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 }
    }
    fn work() -> Area {
        Area { x: 0.0, y: 0.0, w: 1920.0, h: 1040.0 }
    }

    fn at(mode: PlacementMode, size: (f64, f64)) -> (f64, f64) {
        placed_origin(&Placement { mode, ..Placement::default() }, size, screen(), work())
    }

    #[test]
    fn the_default_hangs_from_the_bottom_of_the_screen() {
        assert_eq!(Placement::default().mode, PlacementMode::BottomLeft);
        // 24 px in from the left, flush with the bottom of the screen: the panel
        // covers the taskbar there.
        assert_eq!(at(PlacementMode::BottomLeft, (720.0, 320.0)), (24.0, 1080.0 - 320.0));
    }

    #[test]
    fn the_taskbar_edge_sits_on_the_taskbar() {
        // Same corner, but the bottom is the top of the 40 px taskbar.
        assert_eq!(at(PlacementMode::TaskbarLeft, (720.0, 320.0)), (24.0, 1040.0 - 320.0));
        let (x, y) = at(PlacementMode::TaskbarRight, (720.0, 320.0));
        assert_eq!(x, 1920.0 - 24.0 - 720.0);
        assert_eq!(y, 1040.0 - 320.0);
    }

    #[test]
    fn the_top_edge_hangs_down_from_the_screen_top() {
        // The top anchor uses the screen, so a taskbar at the bottom changes nothing.
        assert_eq!(at(PlacementMode::TopCenter, (720.0, 320.0)), (600.0, 0.0));
        assert_eq!(at(PlacementMode::TopLeft, (720.0, 320.0)), (24.0, 0.0));
        assert_eq!(at(PlacementMode::TopRight, (720.0, 320.0)).0, 1920.0 - 24.0 - 720.0);
    }

    #[test]
    fn only_the_top_edge_grows_downwards() {
        assert!(PlacementMode::BottomLeft.grows_up());
        assert!(PlacementMode::TaskbarRight.grows_up());
        assert!(!PlacementMode::TopCenter.grows_up());
        assert!(!PlacementMode::TopLeft.grows_up());
    }

    #[test]
    fn a_closed_island_stays_in_its_corner() {
        let (x, y) = at(PlacementMode::BottomLeft, (160.0, 26.0));
        assert_eq!(x, 24.0, "the left edge does not move");
        assert_eq!(y, 1080.0 - 26.0, "the bottom edge does not move");
        let (xr, _) = at(PlacementMode::BottomRight, (160.0, 26.0));
        assert_eq!(xr, 1920.0 - 24.0 - 160.0, "the right edge does not move");
        assert_eq!(at(PlacementMode::TopCenter, (160.0, 26.0)).1, 0.0);
    }

    #[test]
    fn nothing_leaves_the_screen() {
        // An offset larger than the screen pulls the panel back to its origin
        // rather than off the edge.
        let p = Placement { mode: PlacementMode::BottomRight, offset: (5000.0, 5000.0), custom: (0.0, 0.0) };
        let (x, y) = placed_origin(&p, (720.0, 320.0), screen(), work());
        assert_eq!((x, y), (0.0, 0.0));
    }

    #[test]
    fn a_window_bigger_than_the_display_sits_at_the_origin() {
        assert_eq!(at(PlacementMode::BottomLeft, (4000.0, 3000.0)), (0.0, 0.0));
    }

    #[test]
    fn a_second_display_is_measured_from_its_own_edges() {
        // A monitor to the left of the primary one: negative coordinates are
        // ordinary, not something to clamp away.
        let left = Area { x: -1920.0, y: -200.0, w: 1920.0, h: 1080.0 };
        let left_work = Area { x: -1920.0, y: -200.0, w: 1920.0, h: 1040.0 };
        let p = Placement::default();
        assert_eq!(
            placed_origin(&p, (720.0, 320.0), left, left_work),
            (-1920.0 + 24.0, -200.0 + 1080.0 - 320.0)
        );
    }

    #[test]
    fn a_broken_setting_never_places_the_window_at_nan() {
        let p = Placement { mode: PlacementMode::BottomLeft, offset: (f64::NAN, f64::INFINITY), custom: (0.0, 0.0) };
        let (x, y) = placed_origin(&p, (720.0, 320.0), screen(), work());
        assert!(x.is_finite() && y.is_finite(), "got {x},{y}");
    }

    #[test]
    fn an_unknown_mode_reads_as_the_default() {
        assert_eq!(PlacementMode::parse("bottomLeft"), PlacementMode::BottomLeft);
        assert_eq!(PlacementMode::parse("bottomRight"), PlacementMode::BottomRight);
        assert_eq!(PlacementMode::parse("taskbarLeft"), PlacementMode::TaskbarLeft);
        assert_eq!(PlacementMode::parse("taskbarRight"), PlacementMode::TaskbarRight);
        assert_eq!(PlacementMode::parse("topLeft"), PlacementMode::TopLeft);
        assert_eq!(PlacementMode::parse("topRight"), PlacementMode::TopRight);
        assert_eq!(PlacementMode::parse("topCenter"), PlacementMode::TopCenter);
        // A typo in settings.json must not leave the island unplaced.
        assert_eq!(PlacementMode::parse("bottomleft"), PlacementMode::BottomLeft);
        assert_eq!(PlacementMode::parse(""), PlacementMode::BottomLeft);
        // The old free position is gone: the island always belongs to an edge.
        assert_eq!(PlacementMode::parse("custom"), PlacementMode::BottomLeft);
    }

    // ── Snapping after a drag ────────────────────────────────────────────────

    #[test]
    fn a_drop_near_the_bottom_of_the_screen_takes_that_edge() {
        // Let go 10 px above the bottom of the screen.
        let p = snapped_placement((30.0, 1080.0 - 320.0 - 10.0, 720.0, 320.0), screen(), work());
        assert_eq!(p.mode, PlacementMode::BottomLeft);
        // Flush with the edge, keeping only the distance from the left.
        assert_eq!(p.offset, (30.0, 0.0));
    }

    #[test]
    fn a_drop_near_the_taskbar_takes_the_taskbar_edge() {
        // Let go 5 px above the taskbar: nearer that edge than the screen bottom.
        let p = snapped_placement((30.0, 1040.0 - 320.0 - 5.0, 720.0, 320.0), screen(), work());
        assert_eq!(p.mode, PlacementMode::TaskbarLeft);
        assert_eq!(p.offset.1, 0.0, "flush on the taskbar, not hovering above it");
    }

    #[test]
    fn a_drop_near_the_top_takes_the_top_edge() {
        let p = snapped_placement((30.0, 8.0, 720.0, 320.0), screen(), work());
        assert_eq!(p.mode, PlacementMode::TopLeft);
        assert_eq!(p.offset.1, 0.0, "flush against the top edge");
    }

    #[test]
    fn the_right_half_always_snaps_to_the_right_corner() {
        let p = snapped_placement((1920.0 - 720.0 - 30.0, 1080.0 - 320.0 - 10.0, 720.0, 320.0), screen(), work());
        assert_eq!(p.mode, PlacementMode::BottomRight);
        assert!((p.offset.0 - 30.0).abs() < 0.001, "got {}", p.offset.0);
    }

    #[test]
    fn nothing_stays_in_the_middle_of_the_screen() {
        // Let go in the centre: it must still fly to an edge.
        let p = snapped_placement((600.0, 380.0, 720.0, 320.0), screen(), work());
        let (_, y) = placed_origin(&p, (720.0, 320.0), screen(), work());
        assert!(y <= 1.0 || y + 320.0 >= 1039.0, "y was {y}: the panel stayed in the middle");
    }

    #[test]
    fn a_snap_round_trips_through_the_geometry() {
        // What snapping stores is what placing reads back: the same corner, on
        // the edge rather than floating above it.
        let dropped = (30.0, 1080.0 - 320.0 - 10.0, 720.0, 320.0);
        let p = snapped_placement(dropped, screen(), work());
        assert_eq!(
            placed_origin(&p, (dropped.2, dropped.3), screen(), work()),
            (dropped.0, 1080.0 - 320.0)
        );
    }

    #[test]
    fn snapping_never_writes_a_negative_offset() {
        let p = snapped_placement((-40.0, 1080.0 - 320.0, 720.0, 320.0), screen(), work());
        assert!(p.offset.0 >= 0.0, "got {}", p.offset.0);
        assert!(p.offset.1 >= 0.0, "got {}", p.offset.1);
    }

    // ── Above the taskbar, below a fullscreen app ────────────────────────────

    #[test]
    fn a_fullscreen_window_covers_its_screen() {
        // 2560×1600 at the origin, as the test machine reports.
        let screens = [(0, 0, 2560, 1600)];
        assert!(covers_a_screen((0, 0, 2560, 1600), &screens));
        // Overshooting counts too: some players hide the cursor by going past.
        assert!(covers_a_screen((-1, -1, 2561, 1601), &screens));
    }

    #[test]
    fn a_maximised_window_does_not_count_as_fullscreen() {
        // Maximised stops at the work area, above a 48 px taskbar.
        let screens = [(0, 0, 2560, 1600)];
        assert!(!covers_a_screen((0, 0, 2560, 1552), &screens));
        // And so does an ordinary window.
        assert!(!covers_a_screen((100, 100, 1200, 900), &screens));
    }

    #[test]
    fn a_second_screen_is_matched_on_its_own_bounds() {
        let screens = [(0, 0, 1920, 1080), (1920, 0, 1920, 1080)];
        assert!(covers_a_screen((1920, 0, 3840, 1080), &screens), "the right-hand one");
        assert!(!covers_a_screen((960, 0, 2880, 1080), &screens), "spanning two is not covering one");
    }

    #[test]
    fn no_screens_means_nothing_is_covered() {
        assert!(!covers_a_screen((0, 0, 2560, 1600), &[]));
    }
}


pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

/// Places and sizes the window: the full panel, or `collapsed` to the size the
/// closed island needs (the wake strip when it shows nothing).
/// Windows: how far a taskbar docked at the top of this display (or another
/// app bar there) pushes the island down, read from the display's work area,
/// so the island sits under it (#956). An auto-hidden taskbar takes no work
/// area and moves nothing. Linux anchors the island to the screen edge: 0.
fn top_inset(m: &tauri::Monitor) -> i32 {
    if cfg!(windows) {
        top_inset_from(m.position().y, m.work_area().position.y)
    } else {
        0
    }
}

fn top_inset_from(monitor_y: i32, work_y: i32) -> i32 {
    let inset = work_y - monitor_y;
    if (0..200).contains(&inset) { inset } else { 0 }
}

/// Which edge of the display the panel hangs from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Edge {
    /// The bottom of the screen: the panel covers the taskbar.
    ScreenBottom,
    /// The top of the taskbar: the panel sits on it, taskbar still visible.
    TaskbarTop,
    /// The top of the screen, where the Mac has its notch.
    ScreenTop,
}

/// Which side of that edge the panel is aligned to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Left,
    Right,
    Center,
}

/// Where the island grows from. Every mode names an edge: a panel floating in
/// the middle of the screen is not one of the choices.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum PlacementMode {
    #[default]
    BottomLeft,
    BottomRight,
    TaskbarLeft,
    TaskbarRight,
    TopLeft,
    TopRight,
    TopCenter,
}

impl PlacementMode {
    /// Anything unknown reads as the default: `settings.json` is a file people
    /// edit, and a typo should not leave the island unplaced.
    pub fn parse(mode: &str) -> PlacementMode {
        match mode {
            "bottomRight" => PlacementMode::BottomRight,
            "taskbarLeft" => PlacementMode::TaskbarLeft,
            "taskbarRight" => PlacementMode::TaskbarRight,
            "topLeft" => PlacementMode::TopLeft,
            "topRight" => PlacementMode::TopRight,
            "topCenter" => PlacementMode::TopCenter,
            // "custom" and anything unknown: the island always belongs to an
            // edge, so a free position falls back to the default corner.
            _ => PlacementMode::BottomLeft,
        }
    }

    pub fn edge(self) -> Edge {
        match self {
            PlacementMode::BottomLeft | PlacementMode::BottomRight => Edge::ScreenBottom,
            PlacementMode::TaskbarLeft | PlacementMode::TaskbarRight => Edge::TaskbarTop,
            PlacementMode::TopLeft | PlacementMode::TopRight | PlacementMode::TopCenter => Edge::ScreenTop,
        }
    }

    pub fn side(self) -> Side {
        match self {
            PlacementMode::BottomLeft | PlacementMode::TaskbarLeft | PlacementMode::TopLeft => Side::Left,
            PlacementMode::BottomRight | PlacementMode::TaskbarRight | PlacementMode::TopRight => Side::Right,
            PlacementMode::TopCenter => Side::Center,
        }
    }

    /// The mode for an edge and a side, which is how snapping names a corner.
    pub fn of(edge: Edge, side: Side) -> PlacementMode {
        match (edge, side) {
            (Edge::ScreenBottom, Side::Left) | (Edge::ScreenBottom, Side::Center) => PlacementMode::BottomLeft,
            (Edge::ScreenBottom, Side::Right) => PlacementMode::BottomRight,
            (Edge::TaskbarTop, Side::Left) | (Edge::TaskbarTop, Side::Center) => PlacementMode::TaskbarLeft,
            (Edge::TaskbarTop, Side::Right) => PlacementMode::TaskbarRight,
            (Edge::ScreenTop, Side::Left) => PlacementMode::TopLeft,
            (Edge::ScreenTop, Side::Right) => PlacementMode::TopRight,
            (Edge::ScreenTop, Side::Center) => PlacementMode::TopCenter,
        }
    }

    /// True when the panel grows upwards, so its rounded corners are the top
    /// ones. This is the whole visual difference between the edges.
    pub fn grows_up(self) -> bool {
        !matches!(self.edge(), Edge::ScreenTop)
    }
}

/// A rectangle in logical pixels.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Area {
    pub fn right(&self) -> f64 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

/// What the user asked for, in the shape the geometry needs.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Placement {
    pub mode: PlacementMode,
    pub offset: (f64, f64),
    pub custom: (f64, f64),
}

impl Default for Placement {
    fn default() -> Self {
        Placement {
            mode: PlacementMode::default(),
            // No gap under the island: it sits on the edge of the display.
            offset: (24.0, 0.0),
            custom: (0.0, 0.0),
        }
    }
}

/// The stored settings, in the shape the geometry reads.
pub fn placement_of(p: &crate::settings::IslandPlacement) -> Placement {
    Placement {
        mode: PlacementMode::parse(&p.mode),
        offset: (p.offset_x, p.offset_y),
        custom: (p.custom_x, p.custom_y),
    }
}
/// How close to the bottom of the work area counts as "put it in the corner".
pub const SNAP_PX: f64 = 32.0;

/// Where a drag left the island, expressed as a setting.
///
/// `window` is the island's top-left corner and size in logical pixels relative
/// to the work area it was dropped on. Dropped near the bottom edge it snaps to
/// one of the corners — left or right of the middle, whichever half it is in —
/// and otherwise stays exactly where it was put.
pub fn snapped_placement(window: (f64, f64, f64, f64), screen: Area, work: Area) -> Placement {
    let (x, y, w, h) = window;
    let (x, y, w, h) = (finite(x, 0.0), finite(y, 0.0), finite(w, 0.0), finite(h, 0.0));

    // How far the panel's bottom is from each bottom anchor, and its top from the
    // top one. Whichever it was let go nearest to is the edge it takes, so a
    // panel dropped in the middle of the screen flies to an edge instead of
    // staying there.
    let to_screen_bottom = (screen.bottom() - (y + h)).abs();
    let to_taskbar = (work.bottom() - (y + h)).abs();
    let to_top = (y - screen.y).abs();
    let mut best = (Edge::ScreenBottom, to_screen_bottom);
    for (edge, gap) in [(Edge::TaskbarTop, to_taskbar), (Edge::ScreenTop, to_top)] {
        if gap < best.1 {
            best = (edge, gap);
        }
    }
    let edge = best.0;

    // Left or right of the middle, never the middle itself: the two halves are
    // what a corner means.
    let side = if x + w / 2.0 < screen.x + screen.w / 2.0 {
        Side::Left
    } else {
        Side::Right
    };

    // The panel keeps its place along the edge it took, but goes flush against
    // it: keeping the gap as well would leave a panel dropped in the middle of
    // the screen hovering in the middle of the screen.
    let offset_x = match side {
        Side::Left => x - screen.x,
        _ => screen.right() - (x + w),
    }
    .max(0.0);

    Placement {
        mode: PlacementMode::of(edge, side),
        offset: (offset_x, 0.0),
        custom: (0.0, 0.0),
    }
}

/// The window's top-left corner in logical pixels for a given mode.
///
/// A closed island is smaller than an open one and is placed by the same rule,
/// so it keeps looking attached to its corner while it grows.
pub fn placed_origin(p: &Placement, size: (f64, f64), screen: Area, work: Area) -> (f64, f64) {
    let (w, h) = (finite(size.0, 0.0), finite(size.1, 0.0));
    let (ox, oy) = (finite(p.offset.0, 0.0), finite(p.offset.1, 0.0));
    // The bottom of the screen is the whole display, so the panel covers the
    // taskbar there; the taskbar edge is the work area's bottom, so it sits on
    // top of the taskbar instead.
    let area = match p.mode.edge() {
        Edge::ScreenBottom | Edge::ScreenTop => screen,
        Edge::TaskbarTop => work,
    };
    let x = match p.mode.side() {
        Side::Left => area.x + ox,
        Side::Right => area.right() - ox - w,
        Side::Center => area.x + (area.w - w) / 2.0,
    };
    let y = match p.mode.edge() {
        // Both bottom anchors grow upwards; the top anchor grows downwards.
        Edge::ScreenBottom | Edge::TaskbarTop => area.bottom() - oy - h,
        Edge::ScreenTop => area.y + oy,
    };
    clamp_into_area(x, y, (w, h), screen)
}

/// Keeps the whole window on the display. A window larger than the work area
/// sits at its origin rather than at a negative offset.
fn clamp_into_area(x: f64, y: f64, size: (f64, f64), wa: Area) -> (f64, f64) {
    let (w, h) = size;
    let max_x = (wa.right() - w).max(wa.x);
    let max_y = (wa.bottom() - h).max(wa.y);
    (finite(x, wa.x).clamp(wa.x, max_x), finite(y, wa.y).clamp(wa.y, max_y))
}

/// NaN and infinity have no meaning as a position; fall back rather than pass
/// them to `clamp`, which would keep them.
fn finite(v: f64, fallback: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        fallback
    }
}

pub fn apply_geometry(app: &AppHandle, pref: &str, placement: &Placement, collapsed: Option<(f64, f64)>) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let ms = *m.size();

    let (lw, lh) = collapsed.map(clamp_collapsed).unwrap_or((PANEL_W, PANEL_H));
    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;

    // The work area comes back in physical pixels; the stored position is
    // logical, so both sides of the sum have to agree before it is used.
    //
    // An island hanging from the bottom is measured against the whole display,
    // not the work area: it is meant to sit on the edge of the screen and cover
    // the taskbar, which is how the Mac's island sits in its notch. The top
    // anchor keeps the work area, so a taskbar docked at the top still pushes
    // it down as before.
    let mp = *m.position();
    let wa = m.work_area();
    // Both rectangles are absolute in the virtual desktop and arrive in physical
    // pixels, so they are converted once, here, and everything below is logical.
    let screen = Area {
        x: mp.x as f64 / scale,
        y: mp.y as f64 / scale,
        w: ms.width as f64 / scale,
        h: ms.height as f64 / scale,
    };
    let work = Area {
        x: wa.position.x as f64 / scale,
        y: wa.position.y as f64 / scale,
        w: wa.size.width as f64 / scale,
        h: wa.size.height as f64 / scale,
    };
    let (lx_pos, ly_pos) = placed_origin(placement, (lw, lh), screen, work);
    // The work area is already absolute in the virtual desktop, so the result
    // needs no monitor offset — adding one would count it twice.
    let x = (lx_pos * scale).round() as i32;
    let y = (ly_pos * scale).round() as i32;

    // GTK never sizes a non-resizable window below its natural size (200 px
    // here), so on Linux the 6 px wake strip would stay a 200 px block. tao
    // re-applies the config's `resizable: false` after the first configure, so
    // this is asked every time, just before the resize. Undecorated, the window
    // still offers the user nothing to resize it by. (Found by @YossiYad, #44.)
    #[cfg(target_os = "linux")]
    let _ = win.set_resizable(true);
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    crate::log::line(format!(
        "island geometry: mode={:?} work={:.0},{:.0} {:.0}x{:.0} panel={lw:.0}x{lh:.0} at={x},{y} scale={scale}",
        placement.mode, screen.x, screen.y, screen.w, screen.h
    ));
    let (lx, ly) = logical_origin(&m);
    platform::pin_to_monitor(&win, lx, ly);
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    // Above the taskbar; the watcher below takes it out of the topmost band
    // while a fullscreen app is in front.
    let _ = win.set_always_on_top(true);
    platform::set_topmost(&win, true);

    // On Windows, moving across displays or waking from the strip can clamp or lag
    // the resize. If the physical inner size differs from what was requested, retry once.
    if let Ok(got) = win.inner_size() {
        if got.width != pw || got.height != ph {
            crate::log::line(format!(
                "window size mismatch: wanted {pw}x{ph}, got {}x{} (scale {scale}, monitor {}x{})",
                got.width, got.height, ms.width, ms.height
            ));
            let _ = win.set_size(PhysicalSize::new(pw, ph));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// A closed island never grows past the panel, and never shrinks below one
/// pixel (a zero-sized window can't be placed).
pub fn clamp_collapsed((w, h): (f64, f64)) -> (f64, f64) {
    let ok = |v: f64, max: f64| if v.is_finite() { v.clamp(1.0, max) } else { max };
    (ok(w, PANEL_W), ok(h, PANEL_H))
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y + top_inset(&m), size.width, size.height, m.scale_factor().to_bits()))
}

/// Whether a window's box covers one of these screens edge to edge.
///
/// A maximised window stops at the work area, so it never matches; a borderless
/// fullscreen video does. `screens` is (x, y, width, height) in physical pixels,
/// the same units Windows reports window rectangles in.
pub fn covers_a_screen(window: (i32, i32, i32, i32), screens: &[(i32, i32, i32, i32)]) -> bool {
    let (l, t, r, b) = window;
    screens
        .iter()
        .any(|(x, y, w, h)| l <= *x && t <= *y && r >= x + w && b >= y + h)
}
/// Keeps the island above the taskbar without covering fullscreen apps.
///
/// Twice a second is enough: the island is either visible or it is not, and a
/// fullscreen video that starts a moment ago is still fullscreen a moment later.
/// A question waiting for an answer overrides the whole thing — a prompt nobody
/// can see is a prompt that times out.
pub fn spawn_topmost_watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let Some(win) = window(&app) else { continue };
        if !win.is_visible().unwrap_or(false) {
            continue;
        }
        let waiting = app
            .try_state::<crate::dsh::Dsh>()
            .map(|d| {
                let snapshot = d.0.lock().unwrap_or_else(|e| e.into_inner());
                !snapshot.pending.is_empty()
            })
            .unwrap_or(false);
        let mut own: Vec<isize> = Vec::new();
        if let Ok(raw) = win.hwnd() {
            own.push(raw.0 as isize);
        }
        let covered = if waiting {
            false
        } else {
            let screens: Vec<(i32, i32, i32, i32)> = app
                .available_monitors()
                .map(|ms| {
                    ms.iter()
                        .map(|m| {
                            let p = m.position();
                            let s = m.size();
                            (p.x, p.y, s.width as i32, s.height as i32)
                        })
                        .collect()
                })
                .unwrap_or_default();
            platform::foreground_box(&own)
                .is_some_and(|box_| covers_a_screen(box_, &screens))
        };
        platform::set_topmost(&win, !covered);
    });
}
/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        // Without a cursor to read (Linux) the loop only watches the display
        // layout, and twice a second is plenty for that: waking at 60 Hz just to
        // find no cursor costs CPU for nothing.
        let (period, screen_every) = if platform::CURSOR_POLL { (16, 30) } else { (500, 1) };
        loop {
            // Parked. Folded on Windows, a glance at the cursor four times a
            // second: on the closed island, it is told to wake up, whether or
            // not the webview delivers the pointer to such a small window.
            loop {
                if gate.wait_active_for(Duration::from_millis(250)) {
                    break;
                }
                if platform::CURSOR_POLL && gate.collapsed.load(Ordering::Relaxed) {
                    wake_if_hovered(&app, &gate);
                }
            }
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            // The cursor was far at the last tick, and the page has been told.
            let mut far = false;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(if far { FAR_PERIOD_MS } else { period }));
                if !gate.is_active() {
                    break;
                }

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % screen_every == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                // A press may be the start of a drag: make sure the drop target is
                // ours before the file arrives.
                let down = left_button_down();
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || platform::unblock_webview_drops(&handle));
                }
                was_down = down;

                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                let accept = on_island || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    // Under the gate's lock, and only while it is open: a tick
                    // still running as the island folds must not make the
                    // closed island click-through after set_collapsed made it
                    // take the mouse — nothing would ever wake it again.
                    let active = gate.active.lock().unwrap();
                    if !*active {
                        break;
                    }
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                // Far from the island: the page hears it once, then nothing.
                let near = dragging || is_near(x, y, size);
                if !near && far {
                    continue;
                }
                far = !near;
                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

/// The cursor is on the folded window: it takes the mouse, and the page hears
/// `closed-hover` (it opens the compact island).
fn wake_if_hovered(app: &AppHandle, gate: &PollGate) {
    let Some(win) = window(app) else { return };
    let (Ok(origin), Ok(size), Some((cx, cy))) = (win.outer_position(), win.inner_size(), cursor_physical()) else { return };
    let x = cx - origin.x as f64;
    let y = cy - origin.y as f64;
    if x >= 0.0 && y >= 0.0 && x <= size.width as f64 && y <= size.height as f64 + 2.0 {
        gate.ignoring.store(false, Ordering::Relaxed);
        let _ = win.set_ignore_cursor_events(false);
        let _ = win.emit("closed-hover", ());
    }
}

/// Re-applies click-through after the window or the island changed shape.
///
/// With the cursor poll (Windows) the window takes the mouse again and the next
/// tick decides from the cursor. Without it (Linux) the input region is set to
/// the island itself, or to the whole wake strip while collapsed.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if platform::CURSOR_POLL {
        set_ignore_cursor(app, false);
        gate.forget_ignore_state();
        return;
    }
    let Some(win) = window(app) else { return };
    let region = if gate.collapsed.load(Ordering::Relaxed) {
        // The closed island (or the wake strip) itself, never "the whole
        // window": if the window ever fails to shrink, the rest of it must not
        // swallow clicks meant for whatever sits under the top of the screen.
        let (w, h) = clamp_collapsed(*gate.collapsed_size.lock().unwrap());
        Some((0.0, 0.0, w, h))
    } else {
        let r = *gate.rect.lock().unwrap();
        if r.w <= 0.0 {
            // Nothing drawn yet: nothing takes the mouse.
            Some((0.0, 0.0, 0.0, 0.0))
        } else {
            let x0 = (r.x - HIT_MARGIN).max(0.0);
            let y0 = (r.y - HIT_MARGIN).max(0.0);
            let x1 = r.x + r.w + HIT_MARGIN;
            let y1 = r.y + r.h + HIT_MARGIN;
            Some((x0, y0, x1 - x0, y1 - y0))
        }
    };
    platform::set_input_region(&win, region);
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}