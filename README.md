# Obsidian Vault Web

A small web app that shows and edits an Obsidian vault stored in a GitHub repo. It talks to the GitHub API directly, so it keeps nothing on disk and every save is a commit. The Obsidian Git plugin on your Mac and iPhone picks those commits up on its next pull.

**What it renders:** `[[wikilinks]]` (with `|alias` and `#heading`), embeds (`![[image.png|300]]`, `![[Other note]]`, `![[Note#Section]]`, PDFs, audio and video), callouts (`> [!tip]`, foldable `-`/`+`), `==highlights==`, `#tags`, frontmatter properties, GFM tables and task lists. `%% comments %%` are hidden. Links to notes that don't exist show faded, and clicking one creates the note.

**Editing:** Read, Edit and Split (live preview) modes. Save with Ctrl/Cmd+S. Ctrl/Cmd+E switches between reading and editing. Tab and Shift+Tab indent. Ticking a checkbox in reading view commits right away. If a note changed on GitHub after you opened it (for example, your phone synced), the save is refused, your text is copied to the clipboard and the latest version is loaded. Nothing gets silently overwritten.

Not supported: math/LaTeX, Mermaid, Dataview queries, Canvas rendering, and rename/move. Use Obsidian for those.

---

## 1. Create a GitHub token

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token

- Repository access: **Only select repositories** → `Michaelbecze/Obsidian`
- Permissions → Repository → **Contents: Read and write** (Metadata: read is added automatically)

Copy the token. The app only ever uses it on the server; it never reaches the browser.

## 2. Run it locally

```bash
npm install
GITHUB_TOKEN=github_pat_xxx GITHUB_REPO=Michaelbecze/Obsidian GITHUB_BRANCH=main npm start
# open http://localhost:3000
```

| Setting | Required | Meaning |
|---|---|---|
| `GITHUB_TOKEN` | yes | The fine-grained PAT from step 1 |
| `GITHUB_REPO` | yes | `owner/repo` |
| `GITHUB_BRANCH` | no | Default `main` |
| `VAULT_PATH` | no | Subfolder, if the vault isn't at the repo root |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | no | Simple password gate (see step 4) |
| `COMMIT_AUTHOR_NAME` / `COMMIT_AUTHOR_EMAIL` | no | Committer shown on web edits |

Dot-folders (`.obsidian`, `.trash`) are hidden from the file tree.

## 3. Deploy to Azure App Service (Linux, Node 22)

Using the Azure CLI (`az login` first). The F1 (free) tier works. B1 avoids cold starts.

```bash
RG=rg-vault-web
APP=vault-web-michael          # must be globally unique → https://$APP.azurewebsites.net
LOC=centralus

az group create -n $RG -l $LOC
az appservice plan create -g $RG -n $APP-plan --is-linux --sku F1
az webapp create -g $RG -p $APP-plan -n $APP --runtime "NODE:22-lts"

az webapp config appsettings set -g $RG -n $APP --settings \
  GITHUB_TOKEN=github_pat_xxx \
  GITHUB_REPO=Michaelbecze/Obsidian \
  GITHUB_BRANCH=main \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true

az webapp update -g $RG -n $APP --https-only true

# package & deploy (Azure runs npm install for you)
zip -r app.zip . -x "node_modules/*" "*.zip" ".git/*"
az webapp deploy -g $RG -n $APP --src-path app.zip --type zip
```

Redeploy later by running the last two lines again. The app listens on `$PORT`, which App Service sets automatically. The health check path is `/healthz`.

> Want the token out of app settings? Put it in Key Vault and set the app setting to
> `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/github-token/)`
> after giving the web app's managed identity *Get* access to secrets.

## 4. Lock it down (do this before sharing the URL)

Anyone who reaches the site can edit your vault, so put sign-in in front of it.

**Recommended: App Service Authentication (Easy Auth) with your Microsoft account.** It's free on every tier and needs no code changes.

Portal → your Web App → **Authentication** → *Add identity provider* → **Microsoft**
- App registration: *Create new*. Supported account types: *Current tenant* (or *Any Microsoft account* if you're signing in with a personal MSA)
- Restrict access: **Require authentication**
- Unauthenticated requests: **HTTP 302 redirect**

Then limit it to just you: Entra ID → Enterprise applications → the new app → Properties → **Assignment required = Yes** → Users and groups → add yourself.

CLI equivalent (after creating the app registration):
```bash
az webapp auth update -g $RG -n $APP --enabled true --action RedirectToLoginPage
```

**Quick alternative:** set `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` in app settings. The browser will ask for a username and password. It's fine for personal use over HTTPS, but weaker than Entra sign-in.

## How it fits with Obsidian Git

- Web saves are regular commits on the same branch. Obsidian Git will pull them on its next pull. Turn on *Pull on startup* and an auto-pull interval on each device.
- If you edit the same note on the web and on a device before either one syncs, the web side notices (SHA mismatch) and won't overwrite. The device side resolves the conflict the way Obsidian Git normally does.
- Use **⟳** in the sidebar to fetch the latest file list after a device pushes.

## Files

```
server.js         Express API: /api/tree, /api/file (GET/PUT/DELETE), /api/raw, /api/config
public/index.html
public/app.css    Obsidian-like theme, light and dark, mobile layout
public/app.js     tree, markdown rendering (marked + Obsidian extensions), editor
```
