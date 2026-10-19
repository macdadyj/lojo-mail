# App Store metadata

Copy and screenshots for the App Store listing. They are not compiled into the app.

- `description.txt` is the App Store description.
- `keywords.txt` is a comma-separated list of 100 characters or fewer.
- `support_url.txt` is the placeholder `https://example.com/support`. Replace it in App Store Connect with the real support page before release.
- `screenshots/6.1-inch` is 1170×2532, captured from the iPhone simulator during the phone UI tests (iPhone 14 class).
- `screenshots/6.7-inch` is 1290×2796. This environment has no 6.7-inch simulator, so each file is the 6.1-inch capture scaled to a height of 2796 and cropped by one pixel on each side.

The shots use the UI test mailbox. Do not put secrets, team IDs, or personal addresses in this folder. The repository is public.
