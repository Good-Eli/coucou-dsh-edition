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

/// What the plugin needs beside itself to run.
pub const MODULES: [&str; 3] = ["bridge.mjs", "secure-pipe.mjs", "state-acl.mjs"];

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
/// was. Returns the text unchanged when it is already there.
pub fn with_plugin(text: &str, entry: &str) -> String {
    if is_installed(text) {
        return text.to_string();
    }
    let mut lines = split_lines(text);
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
const SOURCES: [(&str, &str); 3] = [
    ("bridge.mjs", include_str!("../../../../dsh-plugin/bridge.mjs")),
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
pub fn entry_yaml(module_path: &Path, state_dir: &Path) -> String {
    format!(
        "    - id: {PLUGIN_ID_PREFIX}\n      name: 'file:///{}'\n      config:\n        protocol: 1\n        stateDir: '{}'\n        logLevel: info\n",
        slashes(module_path),
        state_dir.display()
    )
}

/// A path as YAML wants it on Windows: forward slashes, no quotes to escape.
fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Where the plugin is copied to, and the state folder it publishes into.
pub fn plugin_dir() -> PathBuf {
    crate::platform::config_dir().join("dsh").join("plugin")
}

pub fn state_dir() -> PathBuf {
    crate::platform::config_dir().join("dsh").join("state")
}

/// The patch file of the running DSH profile.
pub fn patch_file() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    let file = home.join(".dsh").join("profiles").join("desktop").join("cordis.patch.yml");
    file.is_file().then_some(file)
}

// ── Doing it ────────────────────────────────────────────────────────────────

/// Where the modules are written and the id the entry gets.
fn module_path() -> PathBuf {
    plugin_dir().join("bridge.mjs")
}

/// A dated copy of the patch file, next to it, so an edit can always be undone.
fn backup(file: &Path, text: &str) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dir = file.parent().ok_or("the profile has no folder")?.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let dest = dir.join(format!("cordis.patch.yml.{stamp}.bak"));
    std::fs::write(&dest, text).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    Ok(dest)
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
    let dir = plugin_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    for (name, source) in SOURCES {
        let dest = dir.join(name);
        std::fs::write(&dest, source).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    }
    let entry = entry_yaml(&module_path(), &state_dir());
    let changed = edit_profile(|text| with_plugin(text, &entry))?;
    crate::log::line(format!(
        "dsh plugin: {} into {}",
        if changed { "installed" } else { "already installed" },
        module_path().display()
    ));
    Ok(status(false))
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
}
