// Installing the DSH bridge plugin.
//
// The plugin is a file the DSH host loads, so "installing" it means two things:
// copying the module files somewhere stable, and adding one entry to the DSH
// profile's patch file so the host picks it up at its next start.
//
// The patch file is the user's, and it holds entries that are not ours — the
// search adapter lives in the same `insert` list. So nothing here rewrites the
// file: it is edited line by line, only the lines that belong to the bridge are
// touched, and every change keeps a dated backup of what was there before.

use std::path::{Path, PathBuf};

/// How the bridge entry is recognised in the patch file, and by its id.
pub const PLUGIN_ID_PREFIX: &str = "coucou-dsh-bridge";
/// The comment written above the block, so a person reading the file knows what
/// it is and that deleting it is a supported way to undo the install.
pub const MARKER: &str = "# Coucou island bridge (personal DSH Edition). Remove this block to revert.";

/// One line of the patch file, kept with its ending so a rewrite is byte-exact.
fn split_lines(text: &str) -> Vec<String> {
    text.split_inclusive('\n').map(str::to_string).collect()
}

fn is_item_start(line: &str) -> bool {
    line.trim_start().starts_with("- id:") || line.trim_start().starts_with("- insert:")
}

/// The indentation of a line, as a count of leading spaces.
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Where the bridge entry starts, if it is installed.
fn find_entry(lines: &[String]) -> Option<(usize, usize)> {
    let start = lines
        .iter()
        .position(|l| l.trim_start().starts_with("- id:") && l.contains(PLUGIN_ID_PREFIX))?;
    let indent = indent_of(&lines[start]);
    // The entry runs until the next line at the same or shallower indentation
    // that begins a new item.
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, l)| indent_of(l) <= indent && is_item_start(l))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());
    Some((start, end))
}

/// The `insert:` list the bridge entry belongs to, if there is one.
fn find_insert_block(lines: &[String]) -> Option<(usize, usize)> {
    let start = lines
        .iter()
        .position(|l| l.trim_start().starts_with("- insert:"))?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, l)| is_item_start(l) && indent_of(l) <= indent_of(&lines[start]))
        .map(|(i, _)| i)
        .unwrap_or(lines.len());
    Some((start, end))
}

/// True when the patch file already asks for the bridge.
pub fn is_installed(text: &str) -> bool {
    let lines = split_lines(text);
    find_entry(&lines).is_some()
}

/// The patch file with the bridge entry removed, and the marker comment with it
/// when the `insert` list it introduced is left holding nothing.
///
/// Entries that are not ours are untouched, down to their line endings.
pub fn without_plugin(text: &str) -> String {
    let mut lines = split_lines(text);
    let Some((start, end)) = find_entry(&lines) else {
        return text.to_string();
    };
    lines.drain(start..end);

    // If the list this entry was in has nothing left, drop the list and the
    // comment above it: an empty `insert` is noise, and a marker pointing at
    // nothing is worse.
    if let Some((s, e)) = find_insert_block(&lines) {
        let has_items = lines[s + 1..e].iter().any(|l| l.trim_start().starts_with("- id:"));
        if !has_items {
            let mut from = s;
            // Take the marker and any blank line that introduced it.
            while from > 0 {
                let prev = lines[from - 1].trim();
                if prev == MARKER || prev.is_empty() {
                    from -= 1;
                } else {
                    break;
                }
            }
            lines.drain(from..e);
        }
    }
    lines.concat()
}

/// The patch file with the bridge entry added, keeping everything else as it
/// was. An entry that is already there is refreshed when this build's entry
/// differs from it.
///
/// The module URL carries a fingerprint of the bridge source. DSH caches an
/// imported module by its URL, so a host that keeps the old entry keeps running
/// the old code — an updated bridge would not reach a running DSH at all. The
/// entry is therefore rewritten in place when it is stale; a second install of
/// the same build changes nothing.
pub fn with_plugin(text: &str, entry: &str) -> String {
    let mut lines = split_lines(text);
    if let Some((start, end)) = find_entry(&lines) {
        if lines[start..end].concat() == entry {
            return text.to_string();
        }
        lines.splice(start..end, [entry.to_string()]);
        return lines.concat();
    }
    match find_insert_block(&lines) {
        // The usual case: add to the list that is already there, at its top, so
        // the entry sits next to the comment that explains it.
        Some((s, _)) => {
            lines.insert(s + 1, entry.to_string());
            // A marker above a list that already has one is not needed twice.
            lines.concat()
        }
        None => {
            let mut out = lines.concat();
            if !out.ends_with('\n') && !out.is_empty() {
                out.push('\n');
            }
            out.push_str(MARKER);
            out.push('\n');
            out.push_str("- insert:\n");
            out.push_str(entry);
            out
        }
    }
}

/// The plugin sources, carried inside the binary.
///
/// Embedded rather than shipped as resources: the copy written on install is
/// then always the one that matches the running app, and there is no path to
/// get wrong at runtime. The build reads them from the repository's
/// `dsh-plugin/`, so a `windows/`-only checkout cannot build — the two live
/// together in this repository.
const BRIDGE_SOURCE: &str = include_str!("../../../../dsh-plugin/bridge.mjs");

/// The two modules the bridge imports, written beside it under fixed names.
const SUPPORT_SOURCES: [(&str, &str); 2] = [
    ("secure-pipe.mjs", include_str!("../../../../dsh-plugin/secure-pipe.mjs")),
    ("state-acl.mjs", include_str!("../../../../dsh-plugin/state-acl.mjs")),
];

/// What the settings page shows.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The profile asks DSH to load the bridge.
    pub installed: bool,
    /// The DSH profile that would be edited, when there is one.
    pub profile: Option<String>,
    /// Where the modules are written.
    pub plugin_dir: String,
    /// True when the bridge is talking to us right now.
    pub connected: bool,
    /// Why installing cannot work, when it cannot.
    pub problem: Option<String>,
}

/// The YAML of one plugin entry, indented for the `insert` list.
///
/// The module's own file name carries a fingerprint of the bridge source. The
/// loader keys an imported module by its address, and a query string on a
/// `file://` URL did not split that key: DSH kept the module it had already
/// imported and logged the previous build's number after the entry changed. A
/// different file name is a different address whatever the loader does with the
/// path, so the next plugin reload loads what is actually on disk.
pub fn entry_yaml(module_path: &Path, state_dir: &Path) -> String {
    format!(
        "    - id: {PLUGIN_ID_PREFIX}\n      name: 'file:///{}'\n      config:\n        protocol: 1\n        stateDir: '{}'\n        logLevel: info\n",
        slashes(module_path),
        state_dir.display()
    )
}

/// A short fingerprint of the embedded bridge, stable for one build.
fn bridge_rev() -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    BRIDGE_SOURCE.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

/// The same entry, marked disabled.
///
/// Writing this and then the live entry a moment later unloads the running
/// plugin and loads it again — which is what makes DSH drop the module it has
/// already imported under this entry. It is the same two steps the plugin
/// manager performs, done through the profile the bridge already owns.
fn disabled_entry(entry: &str) -> String {
    entry.replacen("      config:\n", "      enabled: false\n      config:\n", 1)
}

/// Puts this build's entry in the profile, reloading a running bridge if needed.
///
/// Returns whether the profile changed. Pointing at the new module is not
/// enough on its own: DSH keeps the namespace it imported first, so a running
/// plugin has to be unloaded before the new file is read. Nor can the entry
/// alone say whether the running bridge is healthy — a pipe host that died
/// leaves the entry looking perfect and no pipe at all. So the caller says
/// whether to reload regardless, and this is the one place that unloads first.
fn install_entry(entry: &str, force_reload: bool) -> Result<bool, String> {
    let current = patch_file()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .unwrap_or_default();
    let matches = with_plugin(&current, entry) == current;
    if matches && !force_reload {
        return Ok(false);
    }
    if is_installed(&current) {
        edit_profile(|text| with_plugin(text, &disabled_entry(entry)))?;
        // DSH reads the patch file on its own watcher; give it the moment it
        // needs to unload the plugin before its entry comes back.
        std::thread::sleep(std::time::Duration::from_millis(800));
        edit_profile(|text| with_plugin(text, entry))?;
        return Ok(true);
    }
    edit_profile(|text| with_plugin(text, entry))
}

/// A path as YAML wants it on Windows: forward slashes, no quotes to escape.
fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Where the plugin is copied to, and the state folder it publishes into.
///
/// Both live under `%LOCALAPPDATA%\Coucou`, beside the log and the hook — the
/// same place `wire::state_dir()` reads `runtime.json` from. Using the
/// preferences folder (`%APPDATA%\Coucou`) here would put the plugin's token in
/// one directory and Coucou's reader in another: the bridge would connect to
/// nothing, and the profile entry would name a file nobody else can find.
pub fn plugin_dir() -> PathBuf {
    crate::platform::local_dir().join("dsh").join("plugin")
}

pub fn state_dir() -> PathBuf {
    crate::platform::local_dir().join("dsh").join("state")
}

/// The patch file of the running DSH profile.
pub fn patch_file() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    let file = home.join(".dsh").join("profiles").join("desktop").join("cordis.patch.yml");
    file.is_file().then_some(file)
}

// ── Doing it ────────────────────────────────────────────────────────────────

/// Where the modules are written and the id the entry gets.
///
/// The bridge file is named after the source it holds: see [`entry_yaml`] for
/// why the name, and not a query string, is what makes DSH import the new code.
fn module_path() -> PathBuf {
    plugin_dir().join(format!("bridge-{}.mjs", bridge_rev()))
}

/// A dated copy of the patch file, next to it, so an edit can always be undone.
///
/// The bridge is reloaded at every start, and a reload writes the profile
/// twice; without a bound the folder would fill with near-identical copies.
fn backup(file: &Path, text: &str) -> Result<PathBuf, String> {
    const KEEP: usize = 10;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dir = file.parent().ok_or("the profile has no folder")?.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // Two writes in the same second would collide: keep them apart.
    let mut dest = dir.join(format!("cordis.patch.yml.{stamp}.bak"));
    let mut n = 1;
    while dest.exists() {
        dest = dir.join(format!("cordis.patch.yml.{stamp}-{n}.bak"));
        n += 1;
    }
    std::fs::write(&dest, text).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    prune_backups(&dir, KEEP);
    Ok(dest)
}

/// Keeps the newest `keep` copies, deleting the rest.
fn prune_backups(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut copies: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("cordis.patch.yml.") && n.ends_with(".bak"))
        })
        .collect();
    if copies.len() <= keep {
        return;
    }
    copies.sort();
    let drop = copies.len() - keep;
    for path in copies.into_iter().take(drop) {
        let _ = std::fs::remove_file(path);
    }
}

/// Reads the profile, hands it to `edit`, and writes the result back — but only
/// when it actually changed, and never without a backup.
fn edit_profile(edit: impl FnOnce(&str) -> String) -> Result<bool, String> {
    let file = patch_file().ok_or("no DSH profile found at ~/.dsh/profiles/desktop")?;
    let before = std::fs::read_to_string(&file).map_err(|e| format!("cannot read the profile: {e}"))?;
    let after = edit(&before);
    if after == before {
        return Ok(false);
    }
    let saved = backup(&file, &before)?;
    crate::log::line(format!("dsh plugin: profile backed up to {}", saved.display()));
    std::fs::write(&file, after).map_err(|e| format!("cannot write the profile: {e}"))?;
    Ok(true)
}

/// The current state, for the settings page.
pub fn status(connected: bool) -> Status {
    let file = patch_file();
    let installed = file
        .as_ref()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|t| is_installed(&t))
        .unwrap_or(false);
    let problem = match &file {
        None => Some("no DSH profile at ~/.dsh/profiles/desktop".to_string()),
        Some(_) => None,
    };
    Status {
        installed,
        profile: file.map(|f| f.display().to_string()),
        plugin_dir: plugin_dir().display().to_string(),
        connected,
        problem,
    }
}

/// Writes the modules and adds the entry. DSH picks it up at its next start.
pub fn apply() -> Result<Status, String> {
    write_sources(&mut false)?;
    let entry = entry_yaml(&module_path(), &state_dir());
    let changed = install_entry(&entry, true)?;
    crate::log::line(format!(
        "dsh plugin: {} into {}",
        if changed { "installed" } else { "already installed" },
        module_path().display()
    ));
    Ok(status(false))
}

/// Writes this build's modules, and says whether anything on disk changed.
///
/// The bridge goes to its fingerprinted name; the two modules it imports keep
/// their plain names. Older bridge files are pruned: each build adds one, and a
/// folder full of them helps nobody.
fn write_sources(changed: &mut bool) -> Result<(), String> {
    let dir = plugin_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let current = module_path();
    if std::fs::read_to_string(&current).ok().as_deref() != Some(BRIDGE_SOURCE) {
        std::fs::write(&current, BRIDGE_SOURCE)
            .map_err(|e| format!("cannot write {}: {e}", current.display()))?;
        *changed = true;
    }
    for (name, source) in SUPPORT_SOURCES {
        let dest = dir.join(name);
        if std::fs::read_to_string(&dest).ok().as_deref() == Some(source) {
            continue;
        }
        std::fs::write(&dest, source).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
        *changed = true;
    }
    prune_old_bridges(&dir, &current);
    Ok(())
}

/// Removes `bridge-<fingerprint>.mjs` files that are not this build's.
fn prune_old_bridges(dir: &Path, current: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.starts_with("bridge-") || !name.ends_with(".mjs") || path == current {
            continue;
        }
        let _ = std::fs::remove_file(&path);
    }
    // The pre-fingerprint name, from builds that wrote a fixed one.
    let legacy = dir.join("bridge.mjs");
    if legacy != *current {
        let _ = std::fs::remove_file(legacy);
    }
}

/// Takes the entry out again. The modules stay on disk: they are small, and
/// leaving them costs nothing if the user changes their mind.
pub fn remove() -> Result<Status, String> {
    let changed = edit_profile(without_plugin)?;
    crate::log::line(format!(
        "dsh plugin: {}",
        if changed { "removed from the profile" } else { "was not installed" }
    ));
    Ok(status(false))
}

/// Brings an installed bridge up to this build and makes sure it is running.
///
/// Called when Coucou starts. The copy on disk can be older than the one inside
/// this binary, the module DSH has loaded can be older still, and the pipe host
/// can have died and left nothing behind. None of that is visible from the
/// profile, so an installed bridge is always unloaded and loaded again — one
/// short gap, and the running bridge always matches the app doing the asking.
/// A profile where the bridge was not installed is left untouched: this never
/// installs it behind the user's back.
pub fn refresh() -> Result<bool, String> {
    let file = match patch_file() {
        Some(file) => file,
        None => return Ok(false),
    };
    let text = std::fs::read_to_string(&file).map_err(|e| format!("cannot read the profile: {e}"))?;
    if !is_installed(&text) {
        return Ok(false);
    }

    let mut changed = false;
    write_sources(&mut changed)?;
    let entry = entry_yaml(&module_path(), &state_dir());
    changed |= install_entry(&entry, true)?;
    if changed {
        crate::log::line("dsh plugin: refreshed the installed bridge to this build");
    }
    Ok(changed)
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A profile that looks like the one on this machine: the bridge inside a
    /// list that also holds an entry that is not ours.
    const PROFILE: &str = "\
- id: ui-chat
  name: '@deepseek-ai/dsh-client-ui-chat'
  config:
    busyEnter: steer

# Coucou island bridge (personal DSH Edition). Remove this block to revert.
- insert:
    - id: coucou-dsh-bridge-abc
      name: 'file:///C:/x/bridge-abc.mjs'
      config:
        protocol: 1
        stateDir: 'C:\\state'
        logLevel: info
    - id: plusvibe-search-adapter
      name: 'file:///C:/x/search.mjs'
      config:
        count: 10
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: plusvibe-search
";

    #[test]
    fn the_bridge_is_found_when_it_is_there() {
        assert!(is_installed(PROFILE));
        assert!(!is_installed("- id: web\n  name: '@deepseek-ai/dsh-web'\n"));
    }

    #[test]
    fn removing_it_keeps_every_other_entry() {
        let out = without_plugin(PROFILE);
        assert!(!is_installed(&out));
        // The neighbour in the same list survives, with its config.
        assert!(out.contains("- id: plusvibe-search-adapter"));
        assert!(out.contains("count: 10"));
        // And so does everything outside it.
        assert!(out.contains("- id: ui-chat"));
        assert!(out.contains("busyEnter: steer"));
        assert!(out.contains("- id: web"));
        assert!(out.contains("searchProvider: plusvibe-search"));
    }

    #[test]
    fn removing_an_entry_that_is_not_there_changes_nothing() {
        let plain = "- id: web\n  name: '@deepseek-ai/dsh-web'\n";
        assert_eq!(without_plugin(plain), plain);
    }

    #[test]
    fn the_marker_goes_when_its_list_is_left_empty() {
        let only_ours = "\
- id: web
  name: '@deepseek-ai/dsh-web'

# Coucou island bridge (personal DSH Edition). Remove this block to revert.
- insert:
    - id: coucou-dsh-bridge-abc
      name: 'file:///C:/x/bridge-abc.mjs'
";
        let out = without_plugin(only_ours);
        assert!(!out.contains("insert:"));
        assert!(!out.contains(MARKER), "a marker with nothing under it is worse than none");
        assert!(out.contains("- id: web"));
    }

    #[test]
    fn installing_adds_one_entry_and_removing_takes_it_away_again() {
        let base = "- id: web\n  name: '@deepseek-ai/dsh-web'\n  config:\n    x: 1\n";
        let entry = entry_yaml(Path::new("C:/x/bridge.mjs"), Path::new("C:/state"));

        let installed = with_plugin(base, &entry);
        assert!(is_installed(&installed));
        assert!(installed.contains("C:/x/bridge.mjs"));
        assert!(installed.contains("stateDir: 'C:/state'"));
        assert!(installed.contains("- id: web"), "the existing entry stays");

        let removed = without_plugin(&installed);
        assert!(!is_installed(&removed));
        assert!(removed.contains("- id: web"));
        assert!(removed.contains("x: 1"));
        // A round trip leaves no trace of the install.
        assert!(!removed.contains(PLUGIN_ID_PREFIX));
        assert!(!removed.contains(MARKER));
    }

    #[test]
    fn installing_twice_does_not_add_it_twice() {
        let base = "- id: web\n";
        let entry = entry_yaml(Path::new("C:/x/bridge.mjs"), Path::new("C:/state"));
        let once = with_plugin(base, &entry);
        let twice = with_plugin(&once, &entry);
        assert_eq!(once, twice);
        assert_eq!(twice.matches(PLUGIN_ID_PREFIX).count(), 1);
    }

    #[test]
    fn a_profile_without_an_insert_list_gets_one() {
        let base = "- id: web\n  name: '@deepseek-ai/dsh-web'\n";
        let entry = entry_yaml(Path::new("C:/x/bridge.mjs"), Path::new("C:/state"));
        let out = with_plugin(base, &entry);
        assert!(out.contains(MARKER));
        assert!(out.contains("- insert:"));
        assert!(is_installed(&out));
        // The existing top-level entry is still a top-level entry.
        assert!(out.starts_with("- id: web"));
    }

    #[test]
    fn a_profile_that_does_not_end_in_a_newline_still_gets_valid_yaml() {
        let base = "- id: web";
        let entry = entry_yaml(Path::new("C:/x/bridge.mjs"), Path::new("C:/state"));
        let out = with_plugin(base, &entry);
        assert!(out.contains("- id: web\n"));
        assert!(out.contains("- insert:"));
    }

    /// The real profile on this machine, so the edit is proven against the file
    /// it will actually run on rather than only against a fixture.
    #[test]
    fn the_real_profile_survives_a_round_trip() {
        let real = match std::env::var_os("USERPROFILE") {
            Some(home) => PathBuf::from(home)
                .join(".dsh")
                .join("profiles")
                .join("desktop")
                .join("cordis.patch.yml"),
            None => return,
        };
        let Ok(text) = std::fs::read_to_string(&real) else { return };

        let removed = without_plugin(&text);
        assert!(!is_installed(&removed), "the entry is gone");
        // Everything outside our entry is still there, line for line. The entry
        // itself is found by id, and every line from it up to the next item goes.
        let lines = split_lines(&text);
        let (start, end) = find_entry(&lines).expect("the real profile has the entry");
        for (i, line) in lines.iter().enumerate() {
            if (start..end).contains(&i) {
                continue;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed == MARKER || trimmed == "- insert:" {
                continue;
            }
            assert!(
                removed.lines().any(|r| r.trim() == trimmed),
                "the edit dropped a line that was not ours: {line}"
            );
        }

        let entry = entry_yaml(&module_path(), &state_dir());
        let reinstalled = with_plugin(&removed, &entry);
        assert!(is_installed(&reinstalled));
        assert!(reinstalled.contains(&module_path().to_string_lossy().replace('\\', "/")));
        // A second round trip is stable.
        assert_eq!(without_plugin(&reinstalled), removed);
    }

    #[test]
    fn the_entry_names_the_module_and_the_state_folder() {
        let entry = entry_yaml(Path::new("C:\\a\\b\\bridge.mjs"), Path::new("C:\\s"));
        assert!(entry.contains("file:///C:/a/b/bridge.mjs"), "YAML wants forward slashes");
        assert!(entry.contains(&format!("- id: {PLUGIN_ID_PREFIX}")));
        assert!(entry.starts_with("    - id:"), "indented for the insert list");
        assert!(entry.ends_with('\n'));
    }

    #[test]
    fn the_plugin_lives_where_the_client_reads_its_token() {
        // A real defect: the installer used the preferences folder while
        // `wire::state_dir()` reads the local one, so the entry it wrote named a
        // bridge whose `runtime.json` Coucou never looked at — the pipe was
        // nowhere to be found and the island stayed disconnected.
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let Some(local) = local else { return };
        let home = local.join("Coucou");
        assert_eq!(state_dir(), home.join("dsh").join("state"));
        assert_eq!(wire_state_dir(), state_dir());
        assert!(plugin_dir().starts_with(&home), "the modules sit beside the state");
    }

    /// The reader's own answer, so the two cannot drift apart again.
    fn wire_state_dir() -> PathBuf {
        super::super::wire::state_dir()
    }

    #[test]
    fn the_module_is_named_after_the_source_it_holds() {
        // A query string on the module URL did not split the loader's cache key:
        // DSH kept the old module and logged the old build number after the
        // entry changed. The file name itself has to differ.
        let path = module_path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, format!("bridge-{}.mjs", bridge_rev()));
        assert!(entry_yaml(&path, Path::new("C:\\s")).contains(&name));
        // Two calls agree, so reinstalling does not churn the entry.
        assert_eq!(bridge_rev(), bridge_rev());
    }

    #[test]
    fn older_bridge_files_are_pruned_and_support_modules_kept() {
        let dir = std::env::temp_dir().join(format!("coucou-plugin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bridge-old.mjs"), "old").unwrap();
        std::fs::write(dir.join("bridge.mjs"), "legacy").unwrap();
        std::fs::write(dir.join("secure-pipe.mjs"), "keep").unwrap();
        let current = dir.join("bridge-mine.mjs");
        std::fs::write(&current, "mine").unwrap();

        prune_old_bridges(&dir, &current);

        assert!(current.exists(), "this build's file stays");
        assert!(dir.join("secure-pipe.mjs").exists(), "the imported module is not ours to prune");
        assert!(!dir.join("bridge-old.mjs").exists());
        assert!(!dir.join("bridge.mjs").exists(), "the pre-fingerprint name goes too");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_entry_is_refreshed_in_place() {
        // The defect: an entry with an older fingerprint was left alone, so DSH
        // kept the module it had already imported and a fixed bridge could not
        // reach a running host without a restart.
        let old = entry_yaml(Path::new("C:/x/bridge-older.mjs"), Path::new("C:/state"));
        let base = "- id: web\n  name: '@deepseek-ai/dsh-web'\n".to_string();
        let installed = with_plugin(&base, &old);
        let fresh = entry_yaml(Path::new("C:/x/bridge-newer.mjs"), Path::new("C:/state"));

        let refreshed = with_plugin(&installed, &fresh);
        assert_ne!(refreshed, installed);
        assert_eq!(refreshed.matches(PLUGIN_ID_PREFIX).count(), 1, "no duplicate entry");
        assert!(refreshed.contains(&fresh), "the entry is this build's");
        assert!(!refreshed.contains("bridge-older.mjs"));
        // Everything that is not ours survives.
        assert!(refreshed.contains("- id: web"));
        // And a second refresh of the same build changes nothing.
        assert_eq!(with_plugin(&refreshed, &fresh), refreshed);
    }

    #[test]
    fn a_reload_unloads_the_entry_before_loading_it_again() {
        // DSH keeps the namespace it imported first, so pointing the entry at a
        // new file is not enough: the running plugin has to go first.
        let entry = entry_yaml(Path::new("C:/x/bridge-new.mjs"), Path::new("C:/state"));
        let off = disabled_entry(&entry);
        assert!(off.contains("      enabled: false\n"), "the first write unloads it");
        assert!(off.contains("bridge-new.mjs"), "and already names the new module");
        // Unloading must not lose the rest of the entry.
        assert!(off.contains("stateDir: 'C:/state'"));
        assert!(off.contains(&format!("- id: {PLUGIN_ID_PREFIX}")));
        // The live entry that follows carries no `enabled` key at all.
        assert!(!entry.contains("enabled:"));
    }
}
