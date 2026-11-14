//! A review as a folder anyone can open: a Markdown report, the rendered screenshots, the evidence
//! and the recordings, and the review itself as JSON.
use crate::blobs::Blobs;
use crate::protocol::Review;
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
    if !review.notes.trim().is_empty() {
        let _ = write!(report, "{}\n\n", review.notes.trim());
    }
    for (index, item) in review.items.iter().enumerate() {
        let n = index + 1;
        std::fs::write(
            folder.join(format!("capture-{n}.png")),
            blobs.read_all(&item.screenshot.sha256)?,
        )?;
        let evidence = blobs.read_all(&item.evidence.sha256)?;
        std::fs::write(folder.join(format!("capture-{n}-evidence.json")), &evidence)?;
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
            "## Capture {n}: {}\n\nPage: {}\n\n![Capture {n}](capture-{n}.png)\n\n",
            escape(title),
            code(&item.page_url)
        );
        if !item.findings.is_empty() {
            report.push_str("What the browser recorded:\n\n");
            for finding in &item.findings {
                let _ = writeln!(report, "- {}", code(finding));
            }
            report.push('\n');
        }
    }
    std::fs::write(folder.join("report.md"), report)?;
    std::fs::write(
        folder.join("review.json"),
        serde_json::to_vec_pretty(review)?,
    )?;
    Ok(folder)
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
