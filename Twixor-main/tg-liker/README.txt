TG LIKER  v1.0
================
X (Twitter) e human-moto Like / Repost / Bookmark.
Kono login, credit, server, AI nai. Shob kichu tomar browser er vitore.

INSTALL
1. Zip ta unzip koro
2. Chrome / Brave e chrome://extensions kholo
3. Developer mode ON koro
4. "Load unpacked" -> unzip kora tg-liker folder select koro
5. X tab khule extension icon e click koro -> SIDE PANEL khulbe (Chrome 114+)

BEBOHAR
- Profile link (https://x.com/username) dao  ->  x.com/username/reposts page e jabe,
  je ja repost korse shob e scroll kore tumi jeta tick dibe seta korbe.
- Tweet link dile Quotes (ba Replies) section e kaj korbe.
- Link khali rakhle current X tab er link nibe.
- Start / Pause / Resume / Stop side panel theke. Panel ta khola thake, tab bodlaleo bondho hoy na. Panel bondho korleo raid cholte thake.
- Stop / Pause dile tab ta oi jaygay thake. Tab nijer theke bondho hoy na.

SPEED
- Turbo       : instant jump, cursor nai
- Human 1.5s/2s/2.5s/3.5s/6s : smooth scroll + mouse cursor like button e giye click
  (Like + Repost + Bookmark ekshathe tick dile prottek post e beshi click lage, tai shomoy ektu beshi hoy)

ADD MORE (Continue)
- Run shesh / Stop hoye gele panel e "Add more posts" box ashe.
- +10 / +20 / +30 / +50 / +100 chap, ba nijer number likho, tarpor "Continue".
- Ager jekhane shesh chhilo shekhan theke shuru hoy: ja ager e handle hoyeche seta skip kore notun post theke.
- Ager same action (like/repost/bookmark), same break system. Counter continue hoy (100 + 20 = 120).
- Notun kore Start dile ager "dekha post" list muche jay, abar prothom theke shuru.

MAX POSTS
- Koyta post dekhbe seta set koro (jemon 100). Like + Skip (already kora / fail) mile 100 hole nijei stop hoy.
- 0 dile unlimited (Stop na dile cholbe).

PANEL E JA JA ACHE
- 🔄 Reset      : counter + "Add more" memory muche idle e fire jay (job na cholle dekhay)
- ⏱ clock       : header e run koto khon cholche (Pause er shomoy thame thake)
- ☕ Break now  : cholar shomoy ekhoni N minute break (boro timer dekhabe). Break timer test korar jonno-o kaje lage.
- Last post line: prottek post e Like / Bookmark / Repost er result (✓ ok, ↷ skip, ✗ fail) + fail er karon
- Kono action porpor 3 bar fail korle oi action ei run e auto bondho hoy, baki action cholte thake (panel e warning dekhay)
- Order: Like -> Bookmark -> Repost (repost menu sobcheye jhamelar, tai shesh e)

TRUSTED CLICK (Repost / Like / Bookmark fallback)
- Normal click X e kaj na korle extension nijei Chrome debugger diye ASOL mouse click pathay.
- Tokhon tab er upore ekta holud bar dekhay: "TG LIKER started debugging this browser". Eta normal, bondho/Cancel korle na (korle fallback kaj korbe na).
- Job shesh / Stop hole bar nijei chole jay. Normal click kaj korle debugger kokhono use hoy na.
- Browser zoom (110%, 125% ...) auto calibrate hoy.

SAFETY
- Break system : prottek N ta post er por M second break (random range). Break er shomoy panel e BOROBORO bold timer dekhay.
- Long break   : beshi post er por (default 100-150 ta post por) lomba break (default 5-10 minute). Timer boro kore, komola/orange rong e dekhay.
- Panel e 'Next break: N post por' dekhay.
- Hourly limit : ghontay max koto ta post e kaj
- Porpor 3 ta post e action fail korle nijei thame jay (X rate limit hote pare)
- Permission : storage, sidePanel, debugger (shudhu trusted click fallback er jonno). Kono website e data pathay na.

DISCLAIMER
X er automation rule onujayi beshi like/repost robot hishebe dhora pore, account restrict hote pare.
Limit + break on rekhe, kom speed e chalao.

SCROLL RECORDER (v1.1) — like job er theke ALADA
- Panel er nicher "🎥 Scroll Recorder" box. Like job cholche kina tar sathe kono shomporko nai.
- X tab e jekhane achho sekhane thako -> "Record + Scroll Up" chap -> Chrome er picker e X tab (ba puro screen) select koro.
- Record shuru hoye oi jayga theke manush er moto smooth uporer dike scroll kore. Profile top e pouchhale nijei record bondho hoye save hoy.
- Pace: Slow / Normal (ref video moto ~1 screen/sec) / Fast.
- Save: "folder/location jiggesh koro" ON thakle Save dialog ashe. OFF hole Downloads/TG-LIKER/. Dialog cancel korle Downloads e save hoy.
- Format: MP4 (Chrome support korle), na hole WebM. Scroll er majhe Stop & Save dile jototuku hoyeche seta save hoy.
- Record cholar shomoy side panel khola rakho.

v1.3 FIX (Scroll Recorder)
- X page er asol scrollbar (baam dik er main scrollbar) ke target kore scroll kore, verify kore ashole scroll hocche kina.
- DOM scroll kaj na korle nijei real mouse-wheel (Chrome debugger) e fallback kore.
- Extension reload er por X tab F5 korte hobe na — "Record + Scroll Up" chaple script nijei inject hoy (notun permission: scripting).
- Update korar por chrome://extensions e TG LIKER er Reload (circular arrow) chap.

v1.4
- Notun pace: Faster / Turbo / Insane (~3 / ~5 / ~9 screen/s).
- Save folder: panel e folder er naam likho (default TG-LIKER), Downloads er vitore save hobe, naam mone thake. "Jiggesh koro" tick default OFF.
- Current X tab seedha record hoy (picker lage na). Eta kaj korte extension ICON e click kore panel kholo (tab refresh korle abar icon e click koro). Na hole age-r moto picker ashbe.

v1.4.1
- Video te nirob audio track jog kora hoyeche: Telegram ar GIF dhorbe na, GIF-off group e o normal video hishebe jabe.

v1.5.0 — BACKGROUND FIX
- Window dhaka porleo (onno window/tab upore ashleo) job cholbe: visibility spoof + Worker timer + focus emulation + keepalive.
- Job cholar shomoy yellow "debugging" bar thakbe (focus emulation er jonno) — eta normal.
- Sobcheye bhalo: chrome://flags/#calculate-native-win-occlusion (Brave e brave://flags/...) -> Disabled, tarpor Relaunch.
- Tab minimize korle kaj korbe na. Window ta screen e rakho, shudhu onno window diye dhaka thakleo cholbe.

v1.6.0 — RECORDER: PICKER LAGE NA
- Default Capture source = Auto: current X tab ke Chrome debugger screencast diye record kore. Picker / icon-click / permission kichu lage na.
- Panel e "Capture source" dropdown: Auto (default) ba Ask (Chrome picker, ager moto). Choice mone thake.
- Auto mode e record cholar shomoy tab er upore holud "debugging" bar thakbe. Ei tab e DevTools (F12) khola thakle Auto fail kore, tokhon nijei ager method e fallback kore.
- Recording tab dhaka thakleo cholbe (focus emulation).

v1.6.1 — AUTO SAVE + FILE NAME
- File name: <username> <time> e.g.  Rukon_Kholifa 11.33 PM 17 Oct.mp4  (username = panel er Profile link theke; khali thakle current tab er link theke). ':' Windows e cholena tai '.' dewa.
- Save dialog ar ashbe na: sobsomoy Downloads/<Save folder>/ e auto save. Same naam hole (1) jog hoy.

v1.7.0 — STOP AT POST
- Panel e 'Stop at post': Pick chap -> X page e post e click. Ba likho '@username post er kichu lekha' ba tweet link.
- Oi post porjonto (post shoho) kaj kore auto stop. Max posts ar Stop point dutor moddhe ja age hoy tate thame.
- Time-ago (3h/4h) use hoyna karon seta bodle jay. Ar chhobi input kora jay na — tai Pick/username+lekha.

v1.7.1 — Stop at post e '#2' (2nd match) support.
