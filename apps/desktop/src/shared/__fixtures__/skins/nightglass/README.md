The skin loader's sample skin (mod.json + tokens.json), written for skin contract 2. One `scenes` block per
scene restyles all three: a backdrop each, the Office's cast sheets, the Tavern's host idle sprite, and per
scene at least one sprite position (a zone's slots) and one map override (an anchor, the board, the lights).
Its sprites and sounds are written by the tests that need them (main/mods/testSkins.ts), so no binary files
are checked in. Its `needs-you` colour and sound are deliberately set: the palette merge must drop both.
