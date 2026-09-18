# README screenshots

Keep documentation screenshots in this directory so GitHub can render them using relative paths. Image files are optional; the main README currently describes the screens and uses Mermaid diagrams for the architecture.

## Suggested images

| Filename | Capture |
| --- | --- |
| `dashboard.png` | Desktop vault with a few clearly fictional entries and the invitation form. |
| `create-account.png` | Account creation screen with empty form fields. |
| `unlock-vault.png` | Locked vault screen with an empty passphrase field. |
| `sidebar.png` | Navigation and account controls using a demo identity. |

Use the existing app screens. Show example identities such as `demo@example.com` and fictional credential labels. Keep passwords hidden and omit actual account addresses, vault codes, authentication links, SMTP settings, and browser tabs containing private information. If using an existing screenshot, review the visible account identity and record details before publishing it.

## Embed images after adding the files

Place the following in the main README's interface section once the corresponding PNG files exist:

```markdown
![Hearth shared vault dashboard with demo credentials](docs/screenshots/dashboard.png)

| Create an account | Unlock your vault |
| --- | --- |
| ![Hearth account creation screen](docs/screenshots/create-account.png) | ![Hearth vault unlock screen](docs/screenshots/unlock-vault.png) |

<details>
<summary>Sidebar and account controls</summary>

![Hearth sidebar with a demo account](docs/screenshots/sidebar.png)

</details>
```

Paths in that example are relative to the root README. Commit the image files along with the Markdown that references them so the repository does not contain broken image links.
