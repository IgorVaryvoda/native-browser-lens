//! VibeQ's HTTP API, as the capture endpoint defines it. HTTPS only (plain HTTP for localhost),
//! no redirects, no cookies kept, the token only ever in headers.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Member {
    pub id: String,
    pub name: String,
}

/// VibeQ's durable record of one submission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub submission_id: String,
    pub observation_id: String,
    pub revision: u64,
    pub task_id: String,
    pub task_url: String,
    pub created_at: f64,
    pub attachment_status: String,
    pub missing_attachments: Vec<String>,
}

pub struct Client {
    base: url::Url,
    token: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(endpoint: &str, token: &str) -> Result<Self, String> {
        let base = validate_endpoint(endpoint)?;
        if token.is_empty() || token.chars().any(|c| c.is_whitespace() || c == ';') {
            return Err("the VibeQ token is empty or has an invalid format".into());
        }
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .into();
        Ok(Self {
            base,
            token: token.into(),
            agent,
        })
    }

    pub fn endpoint(&self) -> String {
        self.base.as_str().trim_end_matches('/').into()
    }

    fn url(&self, path: &str) -> Result<String, String> {
        let url = self.base.join(path).map_err(|e| e.to_string())?;
        if url.host() != self.base.host() {
            return Err("a VibeQ path left its host".into());
        }
        Ok(url.into())
    }

    fn answer(
        result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    ) -> Result<(u16, Vec<u8>), String> {
        let mut response = result.map_err(|e| format!("VibeQ is unreachable: {e}"))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .read_to_vec()
            .map_err(|e| format!("VibeQ's answer broke off: {e}"))?;
        Ok((status, body))
    }

    fn get(&self, path: &str) -> Result<(u16, Vec<u8>), String> {
        Self::answer(
            self.agent
                .get(&self.url(path)?)
                .header("Authorization", &format!("Bearer {}", self.token))
                .call(),
        )
    }

    fn post(&self, path: &str, content_type: &str, body: &[u8]) -> Result<(u16, Vec<u8>), String> {
        Self::answer(
            self.agent
                .post(&self.url(path)?)
                .header("Authorization", &format!("Bearer {}", self.token))
                .content_type(content_type)
                .send(body),
        )
    }

    /// The member the token belongs to.
    pub fn member_id(&self) -> Result<String, String> {
        let (status, body) = Self::answer(
            self.agent
                .get(&self.url("/auth/me")?)
                .header("Authorization", &format!("Bearer {}", self.token))
                .header("Cookie", &format!("session={}", self.token))
                .call(),
        )?;
        let id = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| v["id"].as_str().map(String::from))
            .filter(|id| !id.is_empty());
        match (status, id) {
            (200, Some(id)) => Ok(id),
            _ => Err(format!(
                "VibeQ did not confirm the token's member (HTTP {status})"
            )),
        }
    }

    pub fn members(&self) -> Result<Vec<Member>, String> {
        let (status, body) = self.get("/api/members")?;
        if status != 200 {
            return Err(format!("VibeQ members are unavailable (HTTP {status})"));
        }
        serde_json::from_slice(&body).map_err(|e| format!("VibeQ members are not readable: {e}"))
    }

    /// The receipt of an earlier attempt, or None when VibeQ never recorded it.
    pub fn receipt(&self, submission_id: &str) -> Result<Option<Receipt>, String> {
        let (status, body) = self.get(&format!("/api/capture/v1/submissions/{submission_id}"))?;
        match status {
            404 => Ok(None),
            200 => serde_json::from_slice(&body)
                .map(Some)
                .map_err(|e| format!("VibeQ's receipt is not readable: {e}")),
            _ => Err(format!(
                "the outcome in VibeQ is unknown (HTTP {status}); retry later"
            )),
        }
    }

    /// Uploads one file to the member's staging area; returns its staged key.
    pub fn stage(
        &self,
        filename: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> Result<String, String> {
        let boundary = format!("lens-{}", uuid::Uuid::new_v4().simple());
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let (status, answer) = self.post(
            "/api/attachments/stage",
            &format!("multipart/form-data; boundary={boundary}"),
            &body,
        )?;
        let key = serde_json::from_slice::<Value>(&answer)
            .ok()
            .and_then(|v| v["stagedKey"].as_str().map(String::from));
        match ((200..300).contains(&status), key) {
            (true, Some(key)) => Ok(key),
            _ => Err(format!(
                "the upload of {filename} failed (HTTP {status}); filing can retry"
            )),
        }
    }

    pub fn submit(&self, body: &Value) -> Result<Receipt, String> {
        let bytes = serde_json::to_vec(body).expect("JSON serializes");
        let (status, answer) =
            self.post("/api/capture/v1/submissions", "application/json", &bytes)?;
        if status != 200 && status != 201 {
            let reason = serde_json::from_slice::<Value>(&answer)
                .ok()
                .and_then(|v| v["error"].as_str().map(String::from))
                .unwrap_or_default();
            return Err(format!(
                "VibeQ refused the submission (HTTP {status} {reason})"
            ));
        }
        serde_json::from_slice(&answer).map_err(|e| format!("VibeQ's receipt is not readable: {e}"))
    }
}

/// HTTPS, or plain HTTP to this computer; no credentials in the URL.
pub fn validate_endpoint(endpoint: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(endpoint.trim()).map_err(|_| format!("{endpoint:?} is not a URL"))?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local);
    if !scheme_ok || !url.username().is_empty() || url.password().is_some() || url.host().is_none()
    {
        return Err(
            "use an HTTPS VibeQ address (plain HTTP only for localhost), without a user name"
                .into(),
        );
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_must_be_https_or_local() {
        assert!(validate_endpoint("https://work.sirv.studio").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:3001").is_ok());
        for bad in [
            "http://work.sirv.studio",
            "https://u:p@work.sirv.studio",
            "ftp://x",
            "work.sirv.studio",
        ] {
            assert!(validate_endpoint(bad).is_err(), "{bad} was accepted");
        }
        assert!(Client::new("https://work.sirv.studio", "a b").is_err());
        assert!(Client::new("https://work.sirv.studio", "tok;en").is_err());
    }
}
