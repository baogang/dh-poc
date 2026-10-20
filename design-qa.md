# BALADY mobile client visual QA · 2026-10-20

Final result: **blocked**. Implementation and business interaction regression are complete. Final Apps and Profile recaptures remain blocked by Chrome returning `Debugger unattached`, including after the user reconnected the extension and the browser tool session was reset. This is not a claim that all screens are pixel-perfect.

Deployment exception: the user explicitly chose “先发布，保留未验证标记”. Commit `52d67220059fe9256d57abc4f3d072e04dcabf4f` is live on the existing Render service through deployment `dep-dbbh2ae7bikc73amdv4g` (finished 2026-10-20 06:59:42 UTC). The visual gate remains blocked; this authorization does not convert missing evidence into a pass.

## Visual truth and normalization

Source: <https://dhv2.momah.net/mobile.html>. Original captures are in `docs/evaluation/assets/mobile-client-reference/`.

Implementation captures and combined comparisons are in `docs/evaluation/assets/mobile-client-20261020/`. No source or implementation image was retouched. Comparisons concatenate the originals with a 28px label band.

| State | Source | Implementation | CSS viewport / raster size |
|---|---|---|---|
| Desktop Explore | `desktop-home.png` | `02-desktop-home.png` | 1280×720 / 1280×720, 1 raster pixel per CSS pixel |
| Mobile Explore | `mobile-home-fresh.png` | `11-final-home-mobile.png` | 390×844 / 390×844, 1:1 |
| Mobile Apps | `mobile-apps-fresh.png` | `09-final-apps-mobile.png` | 390×844 / 390×844, 1:1; before FAB visibility fix |
| Mobile Profile | `mobile-profile.png` | `18-profile-final-mobile.png` | 390×844 / 390×844, 1:1; before last 4px header fix |
| Mobile chat | `mobile-chat.png` | `14-chat-native-input-mobile.png` | 390×844 / 390×844; same chrome, different actual conversation state |

Full-view comparisons: `comparison-home-desktop.png`, `comparison-home-mobile.png`, `comparison-apps-mobile.png`, `comparison-profile-mobile-final.png`. Focused inspection used the phone bounds, header, navigation, assets and form regions in these same combined inputs. The phone at 1280×720 has measured CSS bounds x=491.890625, y=89, width=296.2109375, height=621, matching the source measurement.

Captures `12-profile-fixed-mobile.png`, `13-apps-fixed-mobile.png` and `17-apps-final-mobile.png` are rejected as mobile comparison evidence: the browser returned a scaled desktop view or incorrect raster height. They are retained as audit history and must not be presented as successful mobile QA.

## Findings and iteration history

1. **[P1, fixed] Quick login sheet invisible.** `03-quick-login-gate.png` showed the underlying page because the source uses `.quick-sheet.on`, while the initial adapter used `.open`. Corrected the class, made covered controls inert, and verified the visible gate and existing POC login in the browser. `05-login-fixed.png` and subsequent successful login are post-fix evidence.
2. **[P1, fixed] Chat bubbles overlapped the composer.** `06-mobile-chat.png` exposed a collision with the source's absolute `.assistant` hero rule. Removed the conflicting welcome class, reset positioning on native assistant cards, hid the full desktop welcome, and reused an explicit outer chat scroller. `08-final-chat-desktop.png` and `14-chat-native-input-mobile.png` show readable bubbles and native review cards after the fix. Renderer regression tests cover scrolling and focus retention inside a shadow root.
3. **[P2, fixed; final capture pending] Profile section spacing and Apps/Profile floating avatar.** Initial CSS rewriting accidentally affected class names ending in `body`; selectors are now preserved. `18-profile-final-mobile.png` confirms restored 15px margins and no floating avatar. The FAB is hidden outside Explore, verified through the actual navigation/accessibility state. Final Apps mobile capture is still required. The residual 4px Profile header difference was corrected by restoring automatic header height; its final recapture is also required.

## Required fidelity surfaces

- **Typography:** Original IBM Plex Sans WOFF2 files, weights 400/500/600/700, are local assets. Source sizes, line heights, letter spacing and wrapping are retained. Chinese uses the platform fallback as in the source. Main Chatbot typography stays unchanged.
- **Spacing/layout:** Source phone bezel, notch, screen radius, shadows, Explore sheet, scroll strips, cards and bottom navigation are copied. Desktop phone dimensions and mobile Explore spacing were compared at matching viewports. Chat uses the same 111px header and native POC cards sized for the phone. Final Apps/Profile recapture is outstanding as stated above.
- **Colors/tokens:** Original source CSS supplies the green header, pale surfaces, borders, gradients, opacity and semantic colors. Chat adapter tokens match the mobile palette. No new palette was substituted.
- **Assets:** Original logo, avatar, stories, map, banners, illustrations and fonts are copied locally; original SVG icon markup is retained. No replacement illustrations, emoji approximations or generated images were introduced. Source URLs and SHA-256 hashes are recorded in `docs/evaluation/mobile-client-assets-20261020.json`.
- **Copy/content:** Reference Explore/Apps/Profile navigation copy is retained. Intentional integration differences are the current POC account, demo login, real POC plan/input/edit/approval/receipt cards, a modal close control, and honest explanations for unconnected voice/navigation services. Original reference-site credentials, OTP, tokens and network code are excluded.

## Interaction and engineering verification

324/324 active engineering tests passed. Static asset/auth/CSP tests were repeated after the CSS rewrite: 2/2 passed. Source/credential checks and unchanged 36-operation OpenAPI validation passed.

Browser-tested against the real configured model and local CRM simulation: existing demo login; navigation; Chinese asset query and rendered table; natural service complaint; native name-role collection; title editing; old-confirmation invalidation; explicit submission returning `PUB-DEMO-000003`; Escape/focus return; shared receipt in the original Chatbot; reopening with the unsent draft retained. No duplicate backend controller or event stream is created by the mobile client. Captured console errors were empty during the working browser session.

Automatic file selection remains unverified. The browser tool blocks `chrome://extensions/`, so the authorized file-URL permission could not be enabled by the agent. Existing manual file input and backend file tests remain intact.

## Remaining checklist

- Restore an attached Chrome debugger and recapture Apps/Profile at verified 390×844 geometry.
- Compare those final captures with the reference and record `final result: passed` only after no actionable P0/P1/P2 differences remain.
- Completed under the explicit user exception: pushed `52d6722` to `balady-crm` and verified the exact Render deployment is live. The post-release mobile browser recapture remains unverified.

final result: blocked
