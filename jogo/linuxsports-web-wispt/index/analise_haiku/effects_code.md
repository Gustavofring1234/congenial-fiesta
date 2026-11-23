# Wii Sports extracted assets: effects, messages, audio, code references

Source: /workspaces/codespaces-blank/linuxsports-game (read-only). Full data: `effects_code.json` in the same folder. Scripts: `scripts/`.
Confidence tags: [high] verified against file structure or exact match; [med] heuristic parse, cross-checked; [low] unverified.

## A. Particle effects (.breff / .breft)

- 10 BREFF (REFF) and 10 BREFT (REFT) files, all sizes match the header `fileSize` field. [high]
- Names are stored as u16 length (incl. NUL) + ASCII + NUL. Parsing by scanning for that pattern recovers the name tables. Record layout: u32, u16, u16, u16 len, name, 4-byte pad (not fully decoded). [med]
- The root name in each file is `<set>_fix` (e.g. `sports_golf_fix`); `nw4r_defcursor_pack.breff` has root `pack_cursor_fix`. [med]
- GX texture headers and pixel data were not decoded; BREFT output is names only. [low for any texture-size claims]

| BREFF (set) | emitter names | texture refs | BREFT names |
|---|---|---|---|
| baseball/sports_baseball | 29 | 20 | 20 |
| bowling/sports_bowling | 16 | 10 | 10 |
| boxing/sports_boxing | 120 | 27 | 28 |
| fitness/sports_physical | 2 | 2 | 2 |
| golf/sports_golf | 57 | 31 | 31 |
| rpcommon/pack_sequence | 12 | 3 | 3 |
| sportsstatic/nw4r_defcursor_pack | 15 | 7 | 7 |
| sportsstatic/sports_common | 83 | 26 | 26 |
| tennis/sports_tennis | 40 | 13 | 13 |
| training/sports_training | 6 | 4 | 4 |

- Texture refs = BREFF names that exactly match a name in a BREFT. Pairing prefers the BREFT in the same folder; all 143 refs resolved same-folder, 0 unresolved. [med]
- Emitter names (e.g. `Bsb_ball_line01`, `Box_hit01_red`) do not match any texture; 380 total. Emitter/effect names are not confirmed as the in-game lookup keys. [med]
- Texture names are not present as standalone files in the project (no `.tpl`/`.bti` with those names under the effect folders). Texture pixel data therefore cannot be checked against the disk. [med]
- Ignored junk: single-char names (`h`, `x`, `L`, ...) that appear from parsing noise.
- Marker-like names `#1_2` and `dummy_tex` are present in BREFT lists and BREFF refs; they are treated as texture names here, not as files. [med]
- Odd entry: `1syuo` in `sports_boxing.breft`, not referenced by any BREFF. Likely parse noise. [low]

## B. Messages

- `common_message.bmg` (133 msgs) and `sports_message.bmg` (1200 msgs) parse as BMG (MESG/INF1/DAT1/MID1). INF1 count matches the TSV row counts. [high]
- Inline tags are 0x001A + u16 group + u16 type + u16 size + payload. Groups seen: 0x0600 (type 0000/0001), 0x0802 (types 0000-0002), 0x08FF. [high]
- The TSV exports write tags as `{tag:GGGG:PP}`. Group 0x0600 appears in 354 sports rows, 0x0802 in 3, 0x08FF in 2. Common file: 14 x 0600 and 18 x 0802 rows. [high]
- No tag group was identified as a font, icon or texture reference. The semantics of 0x0600/0x0802 are not established here. [low]
- No font or texture names appear in `docs/textos/*.tsv` or in BMG strings (grep for font/brfnt/icon: no hits). [high]
- Layout text panes (txt1 in `src/**/blyt/*.brlyt`): 83 layouts, 488 pane strings, 0 containing `{tag:` or message-ID style tokens. Strings are mostly placeholders/labels (e.g. `Wii`, `4444`, `999`, `Baseball`) or UI text. [med]
- Layout texture and font tables: 140 distinct `txl1` texture names (62 found as a project file by basename; the rest are not extracted or parse noise) and 8 distinct `fnl1` font names (6 found; `Db_32_IA4.brfnt` and `Db_62_IA4.brfnt` look truncated). [med]
- Message archives are referenced by code as `common_message.bmg` and `sports_message.bmg`, both resolved. [high]

## C. Audio

- Files: `assets/audio/raw/sportsstatic/common.carc/HomeMenu/HomeButtonSe.brsar` (357 KB) and `SpeakerSe.arc.d/` with 5 `.bwav` files. `assets/audio/decoded/` has 5 `.wav` and `HomeButtonSe_brsar_simbolos.txt`. [high]
- The SYMB block of `HomeButtonSe.brsar` has 27 names (`HOMESE_*` sounds, `SND_GROUP_HOMEBUTTON`, `BANK_HOMEBUTTON`, `PLAYER_*`). This matches the decoded txt exactly. [high]
- Code refers to 69 sound-symbol-like strings (`RP_COM_GAME_SE_*`, `RP_COMMON_SE_*`, `SE_TR_*`, `RP_*_BGM_*`). None matches the 27 HomeButtonSe symbols. [high]
- Code refers to 8 `rp_*_sound.brsar` files (Common_Sports, Health, Tns, Bsb, Gol, Box, Bow). None is in the project; only HomeButtonSe.brsar is extracted. [high]
- Code refs `/HomeMenu/SpeakerSe.arc` and `/HomeMenu/HomeButtonSe.brsar` resolve to the extracted audio folder. [high]
- Mapping of the 5 .bwav to HOMESE names is not established (no direct reference found). [low]

## D. Code references (src/core/decompiled/strings.tsv)

- 4968 table rows, 4314 unique strings, 853 candidate resource strings (ext list plus `/` plus `%` format strings). [high]
- Resolution: path-suffix first, then case-insensitive basename, with `.arc` also matching `.arc.d` folders. Format strings expanded by regex. [med]
- Resolved 647 / unresolved 206.
- By extension (resolved/unresolved): breff 10/3, breft 10/3, carc 10/1, arc 35/9, brlyt 94/13, brlan 337/72, brres 94/2, brfnt 5/2, bmg 2/1, kcl 5/0, plmap 6/0, plight 8/0, pblm 5/0, bti 10/0, brlmc 3/0, brlpa 2/0, brlvi 1/0, tpl 0/1, bin 4/6, dat 3/5, brsar 1/7.
- Code strings name all 10 effect sets (each .breff and .breft resolves to a project file): sports_common, nw4r_defcursor_pack, pack_sequence, sports_training, sports_physical, sports_tennis, sports_baseball, sports_golf, sports_boxing, sports_bowling. Which code path loads which set is not traced. [med]
- Unresolved effect strings: `basic_common.breff/.breft`, `effect_music.breff/.breft` (not in project). `pack_cursor_fix.breff` is the internal root name, and the file is `nw4r_defcursor_pack.breff`. [med]
- Unresolved `.brlan` (72) include fragments with junk prefixes (e.g. `Y$Y%Y.Y8Y9Y...`, `[boxGauge_00...`), and system-menu names (`homeBtn_*.arc`, `_cntBtn_in.brlan`) that are not in the project. [med]
- Format-string expansions: `glf_course_%s.carc` -> 28 courses; `glf_tree%d.brres` -> 2 (glf_tree1/2); `glfHoleOutText_%02d.brlyt` -> 4; `pin_01_stage_%02d.brlan` -> 10; `G3D/%s.brres` -> 152 (too generic). `N_*_%02d` and `T_*_%02d` layout names resolved to 0 files (their textures are packed in archives). [med]
- Non-resource strings such as `/dev/net/kd/*`, `/title/.../play_rec.dat`, `/shared2/wc24/*.bin`, `@24:/mb/*.msg` are system paths, not project files. [high]

## Limits

- Pattern hits are capped in JSON (`resolved` holds first 40, `resolvedCount` holds the total).
- Texture pixel formats and the GX texture directory were not decoded.
- The decompiled code uses string addresses; no xref from code to the strings was computed.
