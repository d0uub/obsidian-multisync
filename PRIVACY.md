# Privacy Policy — Multi Cloud Sync for Obsidian

**Last updated:** 2025-03-26

## Overview

Multi Cloud Sync is an open-source Obsidian plugin that synchronises vault files with cloud storage providers (Dropbox, Google Drive, OneDrive). It runs entirely within the Obsidian desktop application on the user's device.

## Data Collection

This plugin **does not** collect, store, or transmit any personal information to the plugin author or any third party. No analytics, telemetry, or tracking of any kind is included.

## Cloud Storage Access

When you connect a cloud storage account, the plugin accesses **only** the files and folders you explicitly configure for synchronisation. Specifically:

| Provider | Data accessed |
|----------|--------------|
| Dropbox | Files in your configured sync folder, account display name, storage quota |
| Google Drive | Files in your configured sync folder, account email, storage quota |
| OneDrive | Files in your configured sync folder, account display name, storage quota |

All communication with cloud providers uses their official HTTPS APIs with OAuth 2.0 authentication. The plugin never has access to your cloud storage password.

## Data Storage

- **OAuth tokens** are stored locally in Obsidian's plugin data file within your vault (`.obsidian/plugins/obsidian-multisync/data.json`).
- **Sync metadata** (file hashes, timestamps) is stored in the browser's IndexedDB on your device.
- No data is stored on any external server controlled by the plugin author.

## Data Transmission

File contents are transmitted **only** between your device and the cloud storage provider you have authorised. The plugin does not relay data through any intermediary server.

## Third-Party Services

The plugin communicates exclusively with the following services, only when you have linked an account:

- **Dropbox API** (`api.dropboxapi.com`, `content.dropboxapi.com`)
- **Google Drive API** (`www.googleapis.com`)
- **Microsoft Graph API** (`graph.microsoft.com`)

## Open Source

The full source code is available at [https://github.com/d0uub/obsidian-multisync](https://github.com/d0uub/obsidian-multisync) for review.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/d0uub/obsidian-multisync/issues).
