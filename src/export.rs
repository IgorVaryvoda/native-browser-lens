//! A review as a folder anyone can open: a Markdown report, the rendered screenshots, the evidence
//! and the recordings, and the review itself as JSON.
use crate::blobs::Blobs;
use crate::protocol::{CaptureKind, Evidence, Review, ReviewItem, ReviewVoice};
use crate::repro;
use serde_json::Value;
use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};

pub fn export(review: &Review, blobs: &Blobs, root: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(root)?;
    let folder = new_folder(
        root,
        &format!("lens-review-{}-{}", review.id, slug(&review.title)),
    )?;
    // Titles, URLs and console text come from web pages: they are escaped or fenced, so a page
    // cannot add links, images or HTML to a report someone opens later. The person's notes stay
    // Markdown.
    let mut report = format!("# {}\n\n", escape(&review.title));
    // What a reader needs first: the findings in the notes, then the person's own words, then
    // each capture; the raw timelines come last.
    if !review.notes.trim().is_empty() {
        let _ = write!(report, "{}\n\n", review.notes.trim());
    }
    if !review.voice.is_empty() {
        report.push_str("## What the person said\n\nTranscribed on this computer.\n\n");
    }
    for (index, note) in review.voice.iter().enumerate() {
        let n = index + 1;
        let transcript = voice_transcript(note);
        let _ = writeln!(report, "{}", fenced(&transcript));
        std::fs::write(folder.join(format!("voice-{n}.txt")), transcript)?;
    }
    let mut timelines = String::new();
    for (index, item) in review.items.iter().enumerate() {
        let n = index + 1;
        let session = item.kind == CaptureKind::Session;
        std::fs::write(
            folder.join(format!("capture-{n}.png")),
            blobs.read_all(&item.screenshot.sha256)?,
        )?;
        let evidence = blobs.read_all(&item.evidence.sha256)?;
        std::fs::write(folder.join(format!("capture-{n}-evidence.json")), &evidence)?;
        let parsed = repro::parse(&evidence);
        for (name, contents) in reproduction(item, n, parsed.as_ref(), &review.voice) {
            std::fs::write(folder.join(name), contents)?;
        }
        if let Some(recording) = &item.recording {
            std::fs::write(
                folder.join(format!("capture-{n}-recording.json")),
                blobs.read_all(&recording.sha256)?,
            )?;
        }
        let title = if item.page_title.is_empty() {
            &item.page_url
        } else {
            &item.page_title
        };
        let _ = write!(
            report,
            "## {} {n}: {}\n\nPage: {}\n\n![Capture {n}](capture-{n}.png)\n\n",
            if session { "Recording" } else { "Capture" },
            escape(title),
            code(&item.page_url)
        );
        if !item.annotations.is_empty() {
            report.push_str("The person's notes on the recording:\n\n");
            for note in &item.annotations {
                let on: Vec<String> = note.elements.iter().map(|l| code(&l.css)).collect();
                let _ = writeln!(
                    report,
                    "- {}{}",
                    note.text.trim().replace('\n', " "),
                    if on.is_empty() {
                        String::new()
                    } else {
                        format!(" (marked {})", on.join(", "))
                    }
                );
            }
            report.push('\n');
        }
        if !item.findings.is_empty() {
            report.push_str("What the browser recorded:\n\n");
            for finding in &item.findings {
                let _ = writeln!(report, "- {}", code(finding));
            }
            report.push('\n');
        }
        if let Some(evidence) = &parsed {
            let _ = write!(
                timelines,
                "### Capture {n}\n\nOldest first. `capture-{n}.spec.ts` repeats the steps; it does \
                 not check the defect.\n\n{}\n",
                fenced(&repro::timeline(evidence, &context(item, &review.voice)))
            );
        }
    }
    if !timelines.is_empty() {
        let _ = write!(report, "## Timeline\n\n{timelines}");
    }
    std::fs::write(folder.join("report.md"), report)?;
    std::fs::write(
        folder.join("review.json"),
        serde_json::to_vec_pretty(review)?,
    )?;
    Ok(folder)
}

fn context<'a>(item: &'a ReviewItem, voice: &'a [ReviewVoice]) -> repro::Context<'a> {
    repro::Context {
        voice,
        notes: &item.annotations,
        screen: &item.screen,
        kept: &item.kept,
    }
}

/// A voice note as text: `[mm:ss] words`, one line per stretch of speech.
pub fn voice_transcript(note: &ReviewVoice) -> String {
    let mut out = String::new();
    for segment in &note.segments {
        let s = segment.start_ms / 1000;
        let _ = writeln!(out, "[{:02}:{:02}] {}", s / 60, s % 60, segment.text.trim());
    }
    out
}

/// The generated files of one capture: its timeline, a Playwright test, and a HAR file.
pub fn reproduction(
    item: &ReviewItem,
    n: usize,
    evidence: Option<&Evidence>,
    voice: &[ReviewVoice],
) -> Vec<(String, Vec<u8>)> {
    let Some(evidence) = evidence else {
        return Vec::new();
    };
    let title = if item.page_title.is_empty() {
        &item.page_url
    } else {
        &item.page_title
    };
    vec![
        (
            format!("capture-{n}-timeline.txt"),
            repro::timeline(evidence, &context(item, voice)).into_bytes(),
        ),
        (
            format!("capture-{n}.spec.ts"),
            repro::playwright(evidence, &context(item, voice), n, title, &item.page_url)
                .into_bytes(),
        ),
    ]
    .into_iter()
    .chain({
        // A HAR without recorded answers replays nothing: it is left out.
        let har = repro::har(evidence);
        let empty = har["log"]["entries"].as_array().is_none_or(Vec::is_empty);
        (!empty).then(|| {
            (
                format!("capture-{n}.har"),
                serde_json::to_vec_pretty(&har).expect("HAR serializes"),
            )
        })
    })
    .collect()
}

/// A fenced code block whose fence is longer than any backtick run inside.
fn fenced(text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat((longest + 1).max(3));
    format!("{fence}text\n{}\n{fence}\n", text.trim_end())
}

/// Backslash-escapes Markdown and HTML punctuation, on one line.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().take(500) {
        match c {
            '\n' | '\r' => out.push(' '),
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '(' | ')' | '#' | '+' | '-' | '.'
            | '!' | '|' | '<' | '>' | '~' | '&' => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}

/// An inline code span whose fence is longer than any backtick run inside, so nothing in it renders.
pub fn code(text: &str) -> String {
    let flat: String = text
        .chars()
        .take(500)
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let longest = flat.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest + 1);
    format!("{fence} {flat} {fence}")
}

/// Failed requests, console errors and exceptions, in the order they happened.
pub fn findings(evidence: &Value) -> Vec<String> {
    let events = evidence["events"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    events
        .iter()
        .filter_map(|event| {
            let data = &event["data"];
            let text = |key: &str| data[key].as_str().unwrap_or("").to_string();
            match event["kind"].as_str()? {
                "response" if data["status"].as_u64()? >= 400 => {
                    Some(format!("HTTP {} from {}", data["status"], text("url")))
                }
                "networkFailure" => Some(
                    format!("Request failed: {} {}", text("errorText"), text("url"))
                        .trim_end()
                        .into(),
                ),
                "console" if matches!(data["level"].as_str(), Some("error" | "assert")) => {
                    Some(format!("Console error: {}", text("text")))
                }
                "exception" => Some(format!("Exception: {}", text("text"))),
                _ => None,
            }
        })
        .collect()
}

fn slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "observation".into()
    } else {
        slug.into()
    }
}

/// A folder that did not exist before, so an export never mixes with or replaces another.
fn new_folder(root: &Path, name: &str) -> io::Result<PathBuf> {
    for attempt in 1..=100 {
        let candidate = match attempt {
            1 => root.join(name),
            n => root.join(format!("{name}-{n}")),
        };
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "100 export folders with this name exist",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_short_and_safe() {
        assert_eq!(slug("Cart: total shows NaN!"), "cart-total-shows-nan");
        assert_eq!(slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(slug("   "), "observation");
    }

    #[test]
    fn page_text_cannot_add_markdown() {
        assert_eq!(code("a ``b`` c"), "``` a ``b`` c ```");
        assert_eq!(
            code("x\n![t](https://evil.test/p.png)"),
            "` x ![t](https://evil.test/p.png) `"
        );
        assert_eq!(escape("![t](u) <img>"), "\\!\\[t\\]\\(u\\) \\<img\\>");
    }

    #[test]
    fn findings_list_what_failed() {
        let evidence = serde_json::json!({ "events": [
            { "kind": "response", "data": { "status": 500, "url": "https://a.test/api" } },
            { "kind": "response", "data": { "status": 200, "url": "https://a.test/ok" } },
            { "kind": "console", "data": { "level": "error", "text": "total is NaN" } },
            { "kind": "console", "data": { "level": "log", "text": "hello" } },
        ]});
        assert_eq!(
            findings(&evidence),
            [
                "HTTP 500 from https://a.test/api",
                "Console error: total is NaN"
            ]
        );
    }

    #[test]
    fn never_reuses_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let first = new_folder(dir.path(), "x").unwrap();
        let second = new_folder(dir.path(), "x").unwrap();
        assert_ne!(first, second);
    }
}
