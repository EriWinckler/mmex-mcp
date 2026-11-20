/*******************************************************
 Copyright (C) 2026 EriWinckler (efwinckler@gmail.com)

 This program is free software; you can redistribute it and/or modify
 it under the terms of the MIT License. See the LICENSE file in the
 root of this project for the full text.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 ********************************************************/

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many tests generate a full SQLite fixture on disk. On the Windows CI
    // runners a single generation takes 1 to 4 seconds, so a test that builds
    // two fixtures went past Vitest's 5 second default and failed on
    // windows-2022 with Node 22 and 24. The limit guards against hangs, not
    // against slow disks, so give it room.
    testTimeout: 30_000,
  },
});
