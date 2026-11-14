//! What a DOM recording showed, as text an agent can read without a player. The rrweb events are
//! applied to a map of serialized nodes (no browser): after each click, what appeared on the
//! screen and what went away; after each page load, what the page showed.
use crate::protocol::{ScreenNote, TimeRange};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

/// Changes this long after a click still count as its result.
const SETTLE_MS: i64 = 1500;
const MAX_ITEMS: usize = 25;
const MAX_NOTES: usize = 300;
const MAX_ITEM_CHARS: usize = 120;
/// Deeper trees are not rebuilt: recursion on page-made data needs a bound.
const MAX_DEPTH: usize = 400;
const SKIP: [&str; 6] = ["script", "style", "noscript", "template", "svg", "head"];

#[derive(Default)]
struct Node {
    /// rrweb: 0 document, 2 element, 3 text.
    kind: u64,
    tag: String,
    attributes: Map<String, Value>,
    text: Option<String>,
    children: Vec<i64>,
    /// The other serialized fields (doctype names, `isSVG`, `rootId`, ...), kept for `serialize`.
    rest: Map<String, Value>,
}

#[derive(Default)]
struct Dom {
    nodes: HashMap<i64, Node>,
    root: Option<i64>,
}

impl Dom {
    fn add(&mut self, value: &Value) -> Option<i64> {
        let id = value["id"].as_i64()?;
        let mut node = Node {
            kind: value["type"].as_u64().unwrap_or(99),
            tag: value["tagName"].as_str().unwrap_or("").to_ascii_lowercase(),
            attributes: value["attributes"].as_object().cloned().unwrap_or_default(),
            text: value["textContent"].as_str().map(String::from),
            children: Vec::new(),
            rest: value
                .as_object()
                .map(|o| {
                    o.iter()
                        .filter(|(k, _)| {
                            !["childNodes", "attributes", "textContent"].contains(&k.as_str())
                        })
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect()
                })
                .unwrap_or_default(),
        };
        for child in value["childNodes"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if let Some(child) = self.add(child) {
                node.children.push(child);
            }
        }
        if node.kind == 0 {
            self.root = Some(id);
        }
        self.nodes.insert(id, node);
        Some(id)
    }

    fn remove(&mut self, id: i64) {
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            if let Some(node) = self.nodes.remove(&id) {
                stack.extend(node.children);
            }
        }
    }

    fn mutate(&mut self, data: &Value) {
        let list = |key: &str| data[key].as_array().cloned().unwrap_or_default();
        for r in list("removes") {
            let (Some(parent), Some(id)) = (r["parentId"].as_i64(), r["id"].as_i64()) else {
                continue;
            };
            if let Some(p) = self.nodes.get_mut(&parent) {
                p.children.retain(|c| *c != id);
            }
            self.remove(id);
        }
        for a in list("adds") {
            let Some(parent) = a["parentId"].as_i64() else {
                continue;
            };
            if !self.nodes.contains_key(&parent) {
                continue;
            }
            let Some(id) = self.add(&a["node"]) else {
                continue;
            };
            let next = a["nextId"].as_i64();
            let p = self.nodes.get_mut(&parent).expect("checked above");
            match next.and_then(|n| p.children.iter().position(|c| *c == n)) {
                Some(i) => p.children.insert(i, id),
                None => p.children.push(id),
            }
        }
        for t in list("texts") {
            if let Some(n) = t["id"].as_i64().and_then(|id| self.nodes.get_mut(&id)) {
                n.text = t["value"].as_str().map(String::from);
            }
        }
        for a in list("attributes") {
            let Some(n) = a["id"].as_i64().and_then(|id| self.nodes.get_mut(&id)) else {
                continue;
            };
            for (k, v) in a["attributes"].as_object().into_iter().flatten() {
                if v.is_null() {
                    n.attributes.remove(k);
                } else if let Some(changes) = v.as_object() {
                    let old = n.attributes.get(k).and_then(Value::as_str).unwrap_or("");
                    n.attributes
                        .insert(k.clone(), Value::String(restyle(old, changes)));
                } else {
                    n.attributes.insert(k.clone(), v.clone());
                }
            }
        }
    }

    /// The visible text and the labelled controls, in document order, each once.
    fn screen(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let Some(root) = self.root else { return out };
        let mut stack = vec![root];
        // A page-made cycle in the tree must not loop forever.
        let mut visited = HashSet::new();
        while let Some(id) = stack.pop() {
            if !visited.insert(id) {
                continue;
            }
            let Some(n) = self.nodes.get(&id) else {
                continue;
            };
            if n.kind == 3 {
                if let Some(t) = n.text.as_deref().map(clean).filter(|t| !t.is_empty())
                    && seen.insert(t.clone())
                {
                    out.push(t);
                }
                continue;
            }
            if n.kind == 2 && (SKIP.contains(&n.tag.as_str()) || hidden(n)) {
                continue;
            }
            if n.kind == 2
                && let Some(item) = control(n)
                && seen.insert(item.clone())
            {
                out.push(item);
            }
            stack.extend(n.children.iter().rev());
        }
        out
    }

    /// The node and its subtree as rrweb serialized it, with the changes applied. None when the
    /// page-made tree is deeper than `MAX_DEPTH` or has a cycle: then there is no snapshot.
    fn serialize(&self, id: i64, depth: usize, path: &mut HashSet<i64>) -> Option<Value> {
        if depth > MAX_DEPTH || !path.insert(id) {
            return None;
        }
        let out = self.serialize_node(id, depth, path);
        path.remove(&id);
        out
    }

    fn serialize_node(&self, id: i64, depth: usize, path: &mut HashSet<i64>) -> Option<Value> {
        let n = self.nodes.get(&id)?;
        let mut out = n.rest.clone();
        out.insert("id".into(), id.into());
        if n.kind == 2 {
            out.insert("attributes".into(), Value::Object(n.attributes.clone()));
        }
        if let Some(text) = &n.text {
            out.insert("textContent".into(), text.clone().into());
        }
        if n.kind == 0 || n.kind == 2 {
            let mut children = Vec::with_capacity(n.children.len());
            for child in &n.children {
                if self.nodes.contains_key(child) {
                    children.push(self.serialize(*child, depth + 1, path)?);
                }
            }
            out.insert("childNodes".into(), children.into());
        }
        Some(Value::Object(out))
    }

    fn describe(&self, id: i64) -> String {
        self.nodes
            .get(&id)
            .map(|n| n.tag.clone())
            .unwrap_or_default()
    }
}

fn hidden(n: &Node) -> bool {
    let a = &n.attributes;
    a.contains_key("hidden")
        || a.get("aria-hidden").and_then(Value::as_str) == Some("true")
        || a.get("style")
            .and_then(Value::as_str)
            .is_some_and(|s| s.replace(' ', "").contains("display:none"))
}

/// A labelled field, button or image, as `[field: Coupon]`; `(disabled)` when it is.
fn control(n: &Node) -> Option<String> {
    let kind = match n.tag.as_str() {
        "input" | "textarea" | "select" => "field",
        "button" => "button",
        "img" => "image",
        _ => return None,
    };
    let a = &n.attributes;
    let label = ["aria-label", "placeholder", "alt", "title"]
        .iter()
        .find_map(|k| {
            a.get(*k)
                .and_then(Value::as_str)
                .map(clean)
                .filter(|s| !s.is_empty())
        })?;
    let disabled = if a.contains_key("disabled")
        || a.get("aria-disabled").and_then(Value::as_str) == Some("true")
    {
        " (disabled)"
    } else {
        ""
    };
    Some(format!("[{kind}: {label}{disabled}]"))
}

/// rrweb sends a style change as `{ property: value | [value, priority] | false }`.
fn restyle(old: &str, changes: &Map<String, Value>) -> String {
    let mut declarations: Vec<(String, String)> = old
        .split(';')
        .filter_map(|d| d.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    for (property, change) in changes {
        declarations.retain(|(k, _)| k != property);
        let value = match change {
            Value::String(v) => v.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(Value::as_str)
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" !"),
            _ => continue,
        };
        declarations.push((property.clone(), value));
    }
    declarations
        .iter()
        .map(|(k, v)| format!("{k}: {v};"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The recording with only the kept time ranges. Each range starts with a fresh full snapshot of
/// the page as it was at that moment, so the replay shows no frame from a cut part. Times stay as
/// recorded, so they still match the record's steps.
// ponytail: scroll positions, stylesheet rule changes and canvas data from before a range are not
// carried into its snapshot; the replay shows the page unscrolled until the next change.
pub fn trim(events: &[Value], kept: &[TimeRange]) -> Vec<Value> {
    let mut dom = Dom::default();
    let mut meta: Option<Value> = None;
    let mut out = Vec::new();
    let mut entered: Option<usize> = None;
    for event in events {
        let at = event["timestamp"].as_i64().unwrap_or(0);
        let kind = event["type"].as_u64();
        let range = kept.iter().position(|r| at >= r.from && at <= r.to);
        if let Some(index) = range
            && entered != Some(index)
        {
            entered = Some(index);
            // A range that opens with the page's own meta and snapshot needs no made-up one.
            if kind != Some(4)
                && kind != Some(2)
                && let (Some(meta), Some(root)) = (
                    &meta,
                    dom.root
                        .and_then(|r| dom.serialize(r, 0, &mut HashSet::new())),
                )
            {
                let from = kept[index].from;
                out.push(json!({ "type": 4, "timestamp": from, "data": meta["data"] }));
                out.push(json!({ "type": 2, "timestamp": from, "data": {
                    "node": root, "initialOffset": { "top": 0, "left": 0 } } }));
            }
        }
        match (kind, event["data"]["source"].as_u64()) {
            (Some(4), _) => meta = Some(event.clone()),
            (Some(2), _) => {
                dom = Dom::default();
                dom.add(&event["data"]["node"]);
            }
            (Some(3), Some(0)) => dom.mutate(&event["data"]),
            (Some(3), Some(4)) => {
                if let Some(meta) = meta.as_mut() {
                    meta["data"]["width"] = event["data"]["width"].clone();
                    meta["data"]["height"] = event["data"]["height"].clone();
                }
            }
            _ => {}
        }
        if range.is_some() {
            out.push(event.clone());
        }
    }
    // The replay lasts to the end of the last range, as the person kept it.
    if let (Some(last), Some(range)) = (out.last(), kept.last())
        && last["timestamp"].as_i64().unwrap_or(0) < range.to
    {
        out.push(json!({ "type": 5, "timestamp": range.to, "data": { "tag": "lens-end", "payload": {} } }));
    }
    out
}

fn clean(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > MAX_ITEM_CHARS {
        flat.chars().take(MAX_ITEM_CHARS).collect::<String>() + "…"
    } else {
        flat
    }
}

fn list(items: &[String]) -> String {
    let mut shown: Vec<&str> = items.iter().take(MAX_ITEMS).map(String::as_str).collect();
    if items.len() > MAX_ITEMS {
        shown.push("…");
    }
    shown.join(" | ")
}

/// The screen changes of a recording, oldest first: what each page showed when it loaded, and
/// what each click made appear or go away.
pub fn digest(events: &[Value]) -> Vec<ScreenNote> {
    let mut dom = Dom::default();
    let mut notes = Vec::new();
    let mut pending: Option<(i64, String, HashSet<String>)> = None;
    let settle = |dom: &Dom,
                  pending: &mut Option<(i64, String, HashSet<String>)>,
                  notes: &mut Vec<ScreenNote>| {
        let Some((at, what, before)) = pending.take() else {
            return;
        };
        let now = dom.screen();
        let after: HashSet<&String> = now.iter().collect();
        let appeared: Vec<String> = now
            .iter()
            .filter(|t| !before.contains(*t))
            .cloned()
            .collect();
        let gone: Vec<String> = before
            .iter()
            .filter(|t| !after.contains(t))
            .cloned()
            .collect();
        if appeared.is_empty() && gone.is_empty() {
            return;
        }
        let mut text = format!("after the click on {what}, the screen changed");
        if !appeared.is_empty() {
            text.push_str(&format!("; appeared: {}", list(&appeared)));
        }
        let mut gone_items = gone;
        gone_items.sort();
        if !gone_items.is_empty() {
            text.push_str(&format!("; gone: {}", list(&gone_items)));
        }
        notes.push(ScreenNote {
            at: at + 1,
            text,
            appeared: appeared.into_iter().take(MAX_ITEMS).collect(),
            gone: gone_items.into_iter().take(MAX_ITEMS).collect(),
            after_click: true,
        });
    };
    for event in events {
        let at = event["timestamp"].as_i64().unwrap_or(0);
        if pending.as_ref().is_some_and(|(t, _, _)| at - t > SETTLE_MS) {
            settle(&dom, &mut pending, &mut notes);
        }
        let data = &event["data"];
        match (event["type"].as_u64(), data["source"].as_u64()) {
            (Some(2), _) => {
                settle(&dom, &mut pending, &mut notes);
                dom = Dom::default();
                dom.add(&data["node"]);
                let shown = dom.screen();
                if !shown.is_empty() {
                    notes.push(ScreenNote {
                        at,
                        text: format!("the page showed: {}", list(&shown)),
                        appeared: shown.iter().take(60).cloned().collect(),
                        gone: Vec::new(),
                        after_click: false,
                    });
                }
            }
            (Some(3), Some(0)) => dom.mutate(data),
            // A click (mouse interaction type 2): what it changes shows over the next moments.
            (Some(3), Some(2)) if data["type"].as_u64() == Some(2) => {
                settle(&dom, &mut pending, &mut notes);
                let what = data["id"]
                    .as_i64()
                    .map(|id| dom.describe(id))
                    .unwrap_or_default();
                let before = dom.screen().into_iter().collect();
                pending = Some((
                    at,
                    if what.is_empty() {
                        "the page".into()
                    } else {
                        what
                    },
                    before,
                ));
            }
            _ => {}
        }
        if notes.len() >= MAX_NOTES {
            break;
        }
    }
    settle(&dom, &mut pending, &mut notes);
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Value {
        json!({ "type": 2, "timestamp": 1000, "data": { "node": { "type": 0, "id": 1, "childNodes": [
            { "type": 2, "id": 2, "tagName": "html", "attributes": {}, "childNodes": [
                { "type": 2, "id": 3, "tagName": "head", "attributes": {}, "childNodes": [
                    { "type": 2, "id": 4, "tagName": "title", "attributes": {}, "childNodes": [{ "type": 3, "id": 5, "textContent": "Secret head" }] } ] },
                { "type": 2, "id": 6, "tagName": "body", "attributes": {}, "childNodes": [
                    { "type": 2, "id": 7, "tagName": "button", "attributes": {}, "childNodes": [{ "type": 3, "id": 8, "textContent": "Enhance" }] },
                    { "type": 2, "id": 9, "tagName": "input", "attributes": { "placeholder": "Add a comment", "disabled": "" }, "childNodes": [] },
                    { "type": 2, "id": 10, "tagName": "p", "attributes": { "style": "display: none" }, "childNodes": [{ "type": 3, "id": 11, "textContent": "hidden text" }] }
                ] } ] } ] } } })
    }

    #[test]
    fn a_click_reports_what_appeared_and_went_away() {
        let events = vec![
            page(),
            json!({ "type": 3, "timestamp": 2000, "data": { "source": 2, "type": 2, "id": 7 } }),
            json!({ "type": 3, "timestamp": 2300, "data": { "source": 0, "texts": [], "attributes": [],
                "removes": [{ "parentId": 6, "id": 9 }],
                "adds": [{ "parentId": 6, "nextId": null, "node": { "type": 2, "id": 20, "tagName": "div", "attributes": {}, "childNodes": [
                    { "type": 3, "id": 21, "textContent": "  Upscale   x4 " } ] } }] } }),
            json!({ "type": 3, "timestamp": 9000, "data": { "source": 1 } }),
        ];
        let notes = digest(&events);
        assert_eq!(
            notes[0].text,
            "the page showed: Enhance | [field: Add a comment (disabled)]"
        );
        assert_eq!(notes[1].at, 2001);
        assert_eq!(
            notes[1].text,
            "after the click on button, the screen changed; appeared: Upscale x4; gone: [field: Add a comment (disabled)]"
        );
        assert_eq!(notes.len(), 2);
    }

    #[test]
    fn a_trimmed_recording_starts_each_range_from_the_page_as_it_was() {
        let meta = json!({ "type": 4, "timestamp": 999, "data": { "href": "https://s.test/", "width": 800, "height": 600 } });
        let events = vec![
            meta,
            page(),
            // Cut: the button text becomes a secret, then the style changes.
            json!({ "type": 3, "timestamp": 1500, "data": { "source": 0, "removes": [], "adds": [],
                "texts": [{ "id": 8, "value": "secret 1234" }],
                "attributes": [{ "id": 7, "attributes": { "style": { "color": "red", "margin": ["0", "important"] } } }] } }),
            json!({ "type": 3, "timestamp": 1600, "data": { "source": 0, "removes": [], "adds": [], "attributes": [],
                "texts": [{ "id": 8, "value": "Enhance again" }] } }),
            // Kept from 2000.
            json!({ "type": 3, "timestamp": 2100, "data": { "source": 2, "type": 2, "id": 7 } }),
            json!({ "type": 3, "timestamp": 2600, "data": { "source": 0, "removes": [], "adds": [], "attributes": [],
                "texts": [{ "id": 8, "value": "Done" }] } }),
        ];
        let out = trim(
            &events,
            &[TimeRange {
                from: 2000,
                to: 3000,
            }],
        );
        let text = serde_json::to_string(&out).unwrap();
        assert!(!text.contains("secret"), "{text}");
        assert_eq!(out[0]["type"], 4);
        assert_eq!(out[0]["timestamp"], 2000);
        assert_eq!(out[1]["type"], 2);
        let snapshot = serde_json::to_string(&out[1]).unwrap();
        assert!(snapshot.contains("Enhance again"), "{snapshot}");
        assert!(
            snapshot.contains("color: red; margin: 0 !important;"),
            "{snapshot}"
        );
        assert!(
            snapshot.contains("Secret head"),
            "the head comes back: {snapshot}"
        );
        assert_eq!(out[2]["timestamp"], 2100);
        assert_eq!(out.last().unwrap()["data"]["tag"], "lens-end");
        assert_eq!(out.last().unwrap()["timestamp"], 3000);
        // The rebuilt page reads like the original one.
        let notes = digest(&out);
        assert!(
            notes[0].text.contains("Enhance again"),
            "{:?}",
            notes[0].text
        );
    }

    #[test]
    fn a_cycle_or_a_deep_tree_gives_no_snapshot_and_no_hang() {
        let meta = json!({ "type": 4, "timestamp": 999, "data": { "href": "https://s.test/" } });
        // Body (6) is added under its own child button (7): a cycle.
        let cycle = json!({ "type": 3, "timestamp": 1500, "data": { "source": 0, "removes": [], "texts": [], "attributes": [],
            "adds": [{ "parentId": 7, "nextId": null, "node": { "type": 2, "id": 6, "tagName": "body", "attributes": {}, "childNodes": [
                { "type": 2, "id": 7, "tagName": "button", "attributes": {}, "childNodes": [] } ] } }] } });
        let later =
            json!({ "type": 3, "timestamp": 2100, "data": { "source": 2, "type": 2, "id": 7 } });
        let out = trim(
            &[meta.clone(), page(), cycle, later.clone()],
            &[TimeRange {
                from: 2000,
                to: 3000,
            }],
        );
        assert!(
            out.iter().all(|e| e["type"] != 2),
            "no snapshot from a cycle"
        );
        let _ = digest(&out);

        let mut deep = vec![meta, page()];
        for i in 0..1000 {
            deep.push(json!({ "type": 3, "timestamp": 1500, "data": { "source": 0, "removes": [], "texts": [], "attributes": [],
                "adds": [{ "parentId": if i == 0 { 6 } else { 100 + i - 1 }, "nextId": null,
                    "node": { "type": 2, "id": 100 + i, "tagName": "div", "attributes": {}, "childNodes": [] } }] } }));
        }
        deep.push(later);
        let out = trim(
            &deep,
            &[TimeRange {
                from: 2000,
                to: 3000,
            }],
        );
        assert!(
            out.iter().all(|e| e["type"] != 2),
            "no snapshot from a tree 1000 deep"
        );
    }

    #[test]
    fn junk_does_not_panic() {
        let kept = trim(
            &[json!({}), json!({ "type": 3, "data": { "source": 0 } })],
            &[TimeRange { from: 0, to: 9 }],
        );
        assert_eq!(kept.len(), 3, "both events and the end marker");
        assert!(
            digest(&[
                json!({}),
                json!({ "type": 3, "data": { "source": 0, "adds": [{ "parentId": 99 }] } })
            ])
            .is_empty()
        );
    }
}
