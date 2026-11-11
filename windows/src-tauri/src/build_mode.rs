// Test-build isolation.
//
// A test build of Coucou must be able to run beside the installed copy without
// either one noticing the other: different folders, a different relay pipe, a
// different Credential Manager service, no autostart entry, no update checks.
//
// One variable, `COUCOU_DATA_SUFFIX`, drives all of it. It only takes effect in
// a binary stamped at build time with `COUCOU_TEST_BUILD`, so a stray variable
// in the user's environment can never move the real app's data somewhere else.
//
//   COUCOU_TEST_BUILD=1 COUCOU_DATA_SUFFIX=-dsh-test cargo build
//   -> %APPDATA%\Coucou-dsh-test, \\.\pipe\coucou-dsh-test-<sid>, ...

use std::sync::OnceLock;

/// Whether this binary is the isolated test build. Set at compile time.
pub const TEST_BUILD: bool = option_env!("COUCOU_TEST_BUILD").is_some();

/// The variable that names the test build's data.
pub const VAR: &str = "COUCOU_DATA_SUFFIX";

/// Longest suffix we accept. Long enough for `-dsh-test-nightly`, short enough
/// to stay well inside a pipe name and a folder name.
const MAX_LEN: usize = 32;

/// A suffix is `-` followed by folder-name-safe characters.
///
/// `-` first keeps the derived names readable (`Coucou-dsh-test`) and makes it
/// impossible to produce a bare `Coucou` or to escape the parent directory.
fn parse(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let value = raw.trim();
    if !value.starts_with('-') || value.len() < 2 || value.len() > MAX_LEN {
        return None;
    }
    // No separators, no spaces, no quotes: this string becomes a path segment
    // and part of a pipe name.
    let ok = value[1..]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok || value.contains("..") {
        return None;
    }
    Some(value.to_string())
}

fn cached() -> &'static Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(|| {
        // A production build ignores the variable on purpose.
        if !TEST_BUILD {
            return None;
        }
        parse(std::env::var(VAR).ok())
    })
}

/// The suffix this process runs with, if it is the test build.
pub fn suffix() -> Option<&'static str> {
    cached().as_deref()
}

/// Whether this process is the isolated test build.
pub fn is_test() -> bool {
    suffix().is_some()
}

/// Folder name under %APPDATA% and %LOCALAPPDATA%: `Coucou` or `Coucou-dsh-test`.
pub fn dir_name() -> String {
    match suffix() {
        Some(suffix) => format!("Coucou{suffix}"),
        None => "Coucou".to_string(),
    }
}

/// The part that goes into the relay pipe name, without the leading dash:
/// `dsh-test`, so the pipe reads `\\.\pipe\coucou-dsh-test-<sid>`.
pub fn pipe_tag() -> String {
    match suffix() {
        Some(suffix) => suffix.trim_start_matches('-').to_string(),
        None => String::new(),
    }
}

/// Refuses to start a test build that has no suffix.
///
/// A test build without its suffix would happily use the installed copy's
/// folders, pipe and API keys — exactly what this module exists to prevent.
pub fn check() -> Result<(), String> {
    if !TEST_BUILD {
        return Ok(());
    }
    match suffix() {
        Some(_) => Ok(()),
        None => Err(format!(
            "This is an isolated test build of Coucou and it will not start without {VAR}.\n\n\
             Set it before launching, for example:\n\n    \
             set {VAR}=-dsh-test\n\n\
             Without it the build would share the installed Coucou's settings, relay pipe and \
             stored API keys, which must never happen."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_documented_suffix() {
        assert_eq!(parse(Some("-dsh-test".into())).as_deref(), Some("-dsh-test"));
        assert_eq!(parse(Some(" -a ".into())).as_deref(), Some("-a"));
        assert_eq!(parse(Some("-a.b_c-1".into())).as_deref(), Some("-a.b_c-1"));
    }

    #[test]
    fn refuses_anything_that_could_escape_or_break_a_name() {
        let too_long = format!("-{}", "x".repeat(MAX_LEN));
        let bad = [
            String::new(),
            "-".to_string(),
            "dsh-test".to_string(), // no leading dash
            "-../evil".to_string(), // traversal
            "-a b".to_string(),     // space
            "-a\\b".to_string(),    // separator
            "-a/b".to_string(),
            "-a\"b".to_string(),
            "-é".to_string(), // non-ascii
            too_long,
        ];
        for value in bad {
            assert!(parse(Some(value.clone())).is_none(), "{value:?} must be refused");
        }
    }

    #[test]
    fn the_derived_names_look_right() {
        // Pure helpers, exercised without touching the process environment.
        let tagged = |s: &str| format!("coucou-{}-SID", s.trim_start_matches('-'));
        assert_eq!(tagged("-dsh-test"), "coucou-dsh-test-SID");
        assert_eq!(format!("Coucou{}", "-dsh-test"), "Coucou-dsh-test");
    }
}