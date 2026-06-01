# Facebook Graph API — Learnings & MCP Server Sketch

## 1. App Setup

- App ID: `1290277286624394`, Name: `MCP`
- App läuft im **Development Mode** — nur eingetragene Entwickler/Tester können sie nutzen
- Für Produktivbetrieb: **Business Verification** bei Meta erforderlich
- Tester hinzufügen: Developer Portal → Rollen → Tester (bis zu 25 Personen ohne Veröffentlichung)

### Permissions (Anwendungsfälle)
Folgende Permissions müssen im Developer Portal unter **Anwendungsfälle** aktiviert sein:
- `pages_manage_posts` — Erstellen/Bearbeiten/Veröffentlichen von Posts
- `pages_read_engagement` — Lesen von Page-Daten und Posts
- `pages_show_list` — Liste verwalteter Pages abrufen

---

## 2. OAuth Flow

```
https://www.facebook.com/dialog/oauth
  ?client_id={APP_ID}
  &redirect_uri=https://localhost
  &scope=pages_manage_posts,pages_read_engagement,pages_show_list
  &response_type=token
```

- Response landet in der URL nach `#access_token=`
- `long_lived_token` aus der Response ist ~60 Tage gültig (User Token)
- Für Produktivbetrieb: Long-Lived Token serverseitig gegen System User Token tauschen

### Token-Hierarchie
1. **User Access Token** — kurzlebig, für OAuth
2. **Long-Lived User Token** — ~60 Tage, über Token Exchange
3. **Page Access Token** — abgeleitet vom User Token via `/me/accounts`, für alle Page-Operationen

### Pages abrufen
```
GET /v22.0/me/accounts?access_token={USER_TOKEN}
```
Gibt alle verwalteten Pages mit ihren Page Access Tokens zurück.

---

## 3. Verwaltete Pages

| Page | ID |
|------|----|
| Levin Keller | `1176555975533708` |
| CDU Gemeindeverband Nordstemmen | `102752935221041` |

---

## 4. Posts erstellen

### Veröffentlicht
```
POST /v22.0/{page-id}/feed
  message=...
  link=...           # optional, URL-Preview
  access_token={PAGE_TOKEN}
```

### Draft (erscheint in Business Suite → Entwürfe)
```
POST /v22.0/{page-id}/feed
  message=...
  link=...
  published=false
  unpublished_content_type=DRAFT
  access_token={PAGE_TOKEN}
```
> **Wichtig:** Nur `published=false` ohne `unpublished_content_type=DRAFT` erstellt einen "Dark Post" (unsichtbar in Business Suite). `DRAFT` ist in der offiziellen Doku nicht dokumentiert, aber im Meta Python SDK bestätigt.

### Geplant
```
POST /v22.0/{page-id}/feed
  message=...
  published=false
  scheduled_publish_time={UNIX_TIMESTAMP}   # mindestens 10 min in der Zukunft
  access_token={PAGE_TOKEN}
```

### Draft bearbeiten
```
POST /v22.0/{post-id}
  message=Neuer Text
  access_token={PAGE_TOKEN}
```

### Draft veröffentlichen
```
POST /v22.0/{post-id}
  is_published=true
  access_token={PAGE_TOKEN}
```

### Post löschen
```
DELETE /v22.0/{post-id}
  access_token={PAGE_TOKEN}
```

### Repost auf anderer Page
```
POST /v22.0/{other-page-id}/feed
  link=https://www.facebook.com/permalink.php?story_fbid={post-id}&id={page-id}
  access_token={OTHER_PAGE_TOKEN}
```

---

## 5. Bilder in Posts

Erst Bild hochladen (unpublished):
```
POST /v22.0/{page-id}/photos
  source={binary}
  published=false
  access_token={PAGE_TOKEN}
→ gibt photo_id zurück
```

Dann Post mit Bild:
```
POST /v22.0/{page-id}/feed
  message=...
  published=false
  unpublished_content_type=DRAFT
  attached_media=[{"media_fbid":"photo_id_1"},{"media_fbid":"photo_id_2"}]
  access_token={PAGE_TOKEN}
```

---

## 6. Bekannte Einschränkungen

- **Persönliche Profile:** Kein API-Posting möglich seit 2018 (`publish_actions` deprecated). Gilt auch für Professional Mode / Pro Account.
- **Business Suite Drafts:** `published=false` allein reicht nicht — `unpublished_content_type=DRAFT` nötig.
- **Single-Photo Drafts:** Noch buggy bei `unpublished_content_type=DRAFT`, Workaround: Foto erst separat hochladen, dann als `attached_media` anhängen.
- **Professional Mode Profile:** Tauchen nicht in `/me/accounts` auf, kein API-Zugriff möglich.
- **Token-Ablauf:** User Tokens laufen ab. Für Produktivbetrieb: System User Tokens (ablauflos) über Business Manager anlegen.

---

## 7. Deeplinks

```
# Post direkt anzeigen (nur als Page-Admin sichtbar wenn unpublished)
https://www.facebook.com/permalink.php?story_fbid={POST_ID}&id={PAGE_ID}

# Business Suite Drafts
https://business.facebook.com/latest/posts/draft_posts?asset_id={PAGE_ID}

# Business Suite alle Posts
https://business.facebook.com/latest/posts/published_posts?asset_id={PAGE_ID}
```

---

## 8. MCP Server Sketch — Facebook Connector (Cloudflare Worker)

### Ziel
Ein MCP-Server der als Cloudflare Worker läuft und Facebook Graph API-Operationen als Tools exponiert. Claude (oder andere MCP-Clients) können damit Pages verwalten.

### Stack
- **Runtime:** Cloudflare Worker (Edge, kein Server nötig)
- **MCP Transport:** HTTP/SSE (Streamable HTTP, da Workers kein WebSocket-State halten)
- **Auth:** OAuth Token im Cloudflare KV gespeichert, MCP-Client gibt Page-ID mit

### Architektur

```
KloChat / Claude
    │
    │  MCP (HTTP/SSE)
    ▼
Cloudflare Worker
  ├── /mcp  (MCP endpoint)
  ├── /oauth/start   (Redirect zu Facebook OAuth)
  └── /oauth/callback (Token empfangen, in KV speichern)
    │
    │  HTTPS
    ▼
Facebook Graph API
```

### Cloudflare KV Schema
```
key: "token:{user_id}"
value: {
  user_token: "...",
  pages: {
    "{page_id}": {
      name: "...",
      access_token: "..."
    }
  },
  expires_at: 1234567890
}
```

### MCP Tools

```typescript
// Post erstellen (Draft oder direkt)
create_post(page_id, message, link?, draft?: boolean, images?: string[])

// Post veröffentlichen
publish_post(post_id, page_id)

// Post bearbeiten
edit_post(post_id, page_id, message)

// Post löschen
delete_post(post_id, page_id)

// Auf anderer Page reposten
repost(post_id, source_page_id, target_page_id, message?)

// Pages auflisten
list_pages()

// Bild hochladen
upload_image(page_id, image_url_or_base64)
```

### OAuth Flow im Worker

1. Client ruft `/oauth/start?user_id=xyz` auf
2. Worker redirectet zu Facebook OAuth URL
3. Facebook redirectet zu `/oauth/callback?code=...`
4. Worker tauscht Code gegen Token
5. Token wird in KV gespeichert
6. Fertig — MCP Tools nutzen ab jetzt den gespeicherten Token

### Deployment

```bash
npm create cloudflare@latest facebook-mcp
cd facebook-mcp
# KV namespace anlegen
wrangler kv:namespace create TOKENS
# Secrets setzen
wrangler secret put FACEBOOK_APP_ID
wrangler secret put FACEBOOK_APP_SECRET
wrangler deploy
```

### Wichtige Entscheidungen für den nächsten Agent

- **Token-Refresh:** Long-Lived Tokens (~60 Tage) oder System User Token (ablauflos, braucht Business Manager)
- **Multi-User:** KV key per User-ID, jeder User macht einmal OAuth
- **MCP Auth:** Ob der MCP-Endpoint selbst auth-geschützt sein soll (empfohlen: Bearer Token in KV)
- **Bildhosting:** Bilder müssen öffentlich erreichbar sein für die Graph API — entweder R2 Bucket oder direkte URL

---

## 9. Referenz

- Graph API Explorer: https://developers.facebook.com/tools/explorer/
- App Dashboard: https://developers.facebook.com/apps/1290277286624394/
- Meta Business SDK (Python): https://github.com/facebook/facebook-python-business-sdk
- MCP Spec (Cloudflare Workers): https://developers.cloudflare.com/agents/model-context-protocol/
