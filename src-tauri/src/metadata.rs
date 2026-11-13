use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, redirect::Policy, Client, Url};
use scraper::{Html, Selector};
use serde::Serialize;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use url::Host as UrlHost;

const PAGE_LIMIT: usize = 2 * 1024 * 1024;
const ICON_LIMIT: usize = 256 * 1024;
const MAX_REDIRECTS: usize = 5;
const FETCH_TIMEOUT: Duration = Duration::from_secs(12);

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Serialize)]
pub struct Metadata {
    title: Option<String>,
    icon: Option<String>,
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
                && !(a == 192 && b == 2)
                && !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Allow ordinary global unicast only, excluding transition/special-use ranges.
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && s[1] < 0x200)
                && !(s[0] == 0x2001 && s[1] == 0xdb8)
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

fn validate_url(url: &Url) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only public HTTP/S URLs without credentials are supported".into());
    }
    if let Some(host) = url.host() {
        let ip = match host {
            UrlHost::Ipv4(ip) => Some(IpAddr::V4(ip)),
            UrlHost::Ipv6(ip) => Some(IpAddr::V6(ip)),
            _ => None,
        };
        if ip.is_some_and(|ip| !public_ip(ip)) {
            return Err("Non-public destination rejected".into());
        }
    }
    Ok(())
}

fn validate_addresses(addresses: &[SocketAddr]) -> Result<()> {
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err("DNS returned a non-public or empty destination".into());
    }
    Ok(())
}

async fn client_for(url: &Url) -> Result<Client> {
    validate_url(url)?;
    let host = url.host_str().ok_or("Missing host")?;
    let port = url.port_or_known_default().ok_or("Missing port")?;
    let addresses: Vec<_> = match url.host() {
        Some(UrlHost::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(UrlHost::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        _ => tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "DNS lookup failed")?
            .collect(),
    };
    validate_addresses(&addresses)?;
    // Pin the validated DNS answers to prevent rebinding between validation and connect.
    // Proxies and automatic redirects must not bypass destination validation.
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(Duration::from_secs(4))
        .user_agent("BookmarkDesk/0.1")
        .build()
        .map_err(|e| e.to_string())
}

fn redirect_url(current: &Url, location: &str) -> Result<Url> {
    let next = current.join(location).map_err(|_| "Invalid redirect URL")?;
    validate_url(&next)?;
    Ok(next)
}

fn append_bounded(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<()> {
    if chunk.len() > limit.saturating_sub(bytes.len()) {
        return Err("Response exceeds size limit".into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

async fn fetch_inner(mut url: Url, limit: usize) -> Result<(Url, Vec<u8>)> {
    for hop in 0..=MAX_REDIRECTS {
        let client = client_for(&url).await?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if hop == MAX_REDIRECTS {
                return Err("Too many redirects".into());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .ok_or("Missing redirect location")?
                .to_str()
                .map_err(|_| "Invalid redirect location")?;
            url = redirect_url(&url, location)?;
            continue;
        }
        if !response.status().is_success() {
            return Err("Unsuccessful HTTP response".into());
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err("Response exceeds size limit".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            append_bounded(&mut bytes, &chunk, limit)?;
        }
        return Ok((url, bytes));
    }
    unreachable!()
}

async fn fetch(url: Url, limit: usize) -> Result<(Url, Vec<u8>)> {
    tokio::time::timeout(FETCH_TIMEOUT, fetch_inner(url, limit))
        .await
        .map_err(|_| "Metadata fetch timed out".to_string())?
}

fn extract(page: &[u8], final_url: &Url) -> (Option<String>, Vec<Url>) {
    let document = Html::parse_document(&String::from_utf8_lossy(page));
    let title = document
        .select(&Selector::parse("title").unwrap())
        .next()
        .map(|node| {
            node.text()
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|title| !title.is_empty());
    let mut icons = Vec::new();
    for link in document.select(&Selector::parse("link[href][rel]").unwrap()) {
        if link
            .value()
            .attr("rel")
            .unwrap()
            .split_ascii_whitespace()
            .any(|rel| rel.eq_ignore_ascii_case("icon"))
        {
            if let Ok(url) = final_url.join(link.value().attr("href").unwrap()) {
                if validate_url(&url).is_ok() && !icons.contains(&url) {
                    icons.push(url);
                    break;
                }
            }
        }
    }
    if let Ok(fallback) = final_url.join("/favicon.ico") {
        if !icons.contains(&fallback) {
            icons.push(fallback);
        }
    }
    (title, icons)
}

fn icon_data(bytes: &[u8]) -> Option<String> {
    if bytes.len() > ICON_LIMIT {
        return None;
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if bytes.starts_with(b"\0\0\x01\0") && bytes.len() >= 6 && bytes[4..6] != [0, 0] {
        "image/x-icon"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn fetch_metadata(url: String) -> Result<Metadata> {
    let url = Url::parse(&url).map_err(|_| "Invalid metadata URL")?;
    let (final_url, page) = fetch(url, PAGE_LIMIT).await?;
    let (title, icons) = extract(&page, &final_url);
    with_icons(title, icons, |url| fetch(url, ICON_LIMIT)).await
}

async fn with_icons<F, Fut>(
    title: Option<String>,
    icons: Vec<Url>,
    mut fetch_icon: F,
) -> Result<Metadata>
where
    F: FnMut(Url) -> Fut,
    Fut: std::future::Future<Output = Result<(Url, Vec<u8>)>>,
{
    let mut metadata = Metadata { title, icon: None };
    for url in icons {
        if let Ok((_, bytes)) = fetch_icon(url).await {
            if let Some(icon) = icon_data(&bytes) {
                metadata.icon = Some(icon);
                break;
            }
        }
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_public_addresses() {
        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.1.1",
            "192.168.1.1",
            "100.64.0.1",
            "198.19.0.1",
            "192.0.2.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "64:ff9b::7f00:1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn rejects_unsafe_urls_and_redirects() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com",
            "http://user:pass@example.com",
            "http://2130706433",
            "http://[::1]",
            "http://0x7f000001",
        ] {
            assert!(validate_url(&Url::parse(url).unwrap()).is_err(), "{url}");
        }
        let base = Url::parse("https://example.com/path/page").unwrap();
        assert!(redirect_url(&base, "http://169.254.169.254/latest").is_err());
        assert!(redirect_url(&base, "//127.0.0.1/private").is_err());
        assert_eq!(
            redirect_url(&base, "../next").unwrap().as_str(),
            "https://example.com/next"
        );
    }

    #[test]
    fn rejects_mixed_dns_answers() {
        let public = "8.8.8.8:443".parse().unwrap();
        let private = "127.0.0.1:443".parse().unwrap();
        assert!(validate_addresses(&[]).is_err());
        assert!(validate_addresses(&[public, private]).is_err());
        assert!(validate_addresses(&[public]).is_ok());
    }

    #[test]
    fn extracts_title_and_final_url_relative_icon() {
        let base = Url::parse("https://example.com/redirected/page").unwrap();
        let (title, icons) = extract(
            b"<title>  A &amp; B\n test </title><link rel='shortcut ICON' href='../image.png'>",
            &base,
        );
        assert_eq!(title.as_deref(), Some("A & B test"));
        assert_eq!(icons[0].as_str(), "https://example.com/image.png");
        assert_eq!(icons[1].as_str(), "https://example.com/favicon.ico");
        let (title, icons) = extract(
            b"<title> </title><link rel='icon' href='data:image/svg+xml,bad'>",
            &base,
        );
        assert!(title.is_none());
        assert_eq!(icons.len(), 1);
    }

    #[test]
    fn enforces_stream_size_including_unknown_length_bodies() {
        let mut bytes = vec![1, 2];
        append_bounded(&mut bytes, &[3, 4], 4).unwrap();
        assert!(append_bounded(&mut bytes, &[5], 4).is_err());
        assert_eq!(bytes, [1, 2, 3, 4]);
    }

    #[test]
    fn permits_only_raster_signatures_and_bounded_data_urls() {
        for (bytes, mime) in [
            (b"\x89PNG\r\n\x1a\n".as_slice(), "image/png"),
            (b"\xff\xd8\xff", "image/jpeg"),
            (b"GIF89a", "image/gif"),
            (b"RIFF\0\0\0\0WEBP", "image/webp"),
            (b"\0\0\x01\0\x01\0", "image/x-icon"),
        ] {
            assert_eq!(
                icon_data(bytes).unwrap(),
                format!("data:{mime};base64,{}", STANDARD.encode(bytes))
            );
        }
        for bytes in [
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
            b"<html>error</html>",
            b"",
            b"RIFFnotwebp",
        ] {
            assert!(icon_data(bytes).is_none());
        }
        assert!(icon_data(&vec![0; ICON_LIMIT + 1]).is_none());
    }

    #[tokio::test]
    async fn invalid_linked_icon_uses_favicon_fallback() {
        let base = Url::parse("https://example.com/page").unwrap();
        let (title, icons) = extract(
            b"<title>Example</title><link rel='icon' href='/bad'>",
            &base,
        );
        let mut calls = 0;
        let metadata = with_icons(title, icons, |url| {
            calls += 1;
            async move {
                let bytes = if url.path() == "/bad" {
                    b"<svg/>".to_vec()
                } else {
                    b"GIF89a".to_vec()
                };
                Ok((url, bytes))
            }
        })
        .await
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(metadata.title.as_deref(), Some("Example"));
        assert_eq!(metadata.icon, icon_data(b"GIF89a"));
    }

    #[tokio::test]
    async fn command_rejects_private_page_and_icon_failure_preserves_title() {
        assert!(fetch_metadata("http://127.0.0.1/".into()).await.is_err());
        let base = Url::parse("https://example.com/final").unwrap();
        let (title, icons) = extract(
            b"<title>Still available</title><link rel='icon' href='http://127.0.0.1/icon'>",
            &base,
        );
        let metadata = with_icons(title, icons, |_| async { Err("Icon unavailable".into()) })
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(metadata).unwrap(),
            serde_json::json!({"title": "Still available", "icon": null})
        );
    }
}
