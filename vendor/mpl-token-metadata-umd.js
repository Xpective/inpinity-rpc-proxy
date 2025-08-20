/* ===========================================================
   Vendor Loader (UMD) for @metaplex-foundation/mpl-token-metadata
   Serve this file at: /vendor/mpl-token-metadata-umd.js
   =========================================================== */

(async () => {
  async function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("script load failed: " + url));
      document.head.appendChild(s);
    });
  }

  const candidates = [
    "https://cdn.jsdelivr.net/npm/@metaplex-foundation/mpl-token-metadata@3.4.0/dist/index.umd.min.js",
    "https://unpkg.com/@metaplex-foundation/mpl-token-metadata@3.4.0/dist/index.umd.min.js",
    "https://cdn.jsdelivr.net/npm/@metaplex-foundation/mpl-token-metadata@3.4.0/dist/index.umd.js",
    "https://unpkg.com/@metaplex-foundation/mpl-token-metadata@3.4.0/dist/index.umd.js",
    // Fallback 3.3.x
    "https://cdn.jsdelivr.net/npm/@metaplex-foundation/mpl-token-metadata@3.3.0/dist/index.umd.js",
    "https://unpkg.com/@metaplex-foundation/mpl-token-metadata@3.3.0/dist/index.umd.js",
  ];

  let ok = false, lastErr = null;
  for (const url of candidates) {
    try {
      await loadScript(url);

      // UMD global finden
      let TM =
        window.mpl_token_metadata ||
        window.mplTokenMetadata ||
        (window.metaplex && window.metaplex.mplTokenMetadata) ||
        null;

      if (!TM) throw new Error("UMD global not found");

      // Manche Builds legen Builder unter TM.instructions ab, darum aliasen wir direkt
      TM.createCreateMetadataAccountV2Instruction =
        TM.createCreateMetadataAccountV2Instruction || TM.instructions?.createCreateMetadataAccountV2Instruction;
      TM.createCreateMetadataAccountV3Instruction =
        TM.createCreateMetadataAccountV3Instruction || TM.instructions?.createCreateMetadataAccountV3Instruction;
      TM.createCreateMasterEditionV3Instruction =
        TM.createCreateMasterEditionV3Instruction || TM.instructions?.createCreateMasterEditionV3Instruction;
      TM.createUpdateMetadataAccountV2Instruction =
        TM.createUpdateMetadataAccountV2Instruction || TM.instructions?.createUpdateMetadataAccountV2Instruction;
      TM.createVerifyCollectionInstruction =
        TM.createVerifyCollectionInstruction || TM.instructions?.createVerifyCollectionInstruction;
      TM.createSetAndVerifyCollectionInstruction =
        TM.createSetAndVerifyCollectionInstruction || TM.instructions?.createSetAndVerifyCollectionInstruction;

      // Fallback PROGRAM_ID (Mainnet v1)
      TM.PROGRAM_ID = TM.PROGRAM_ID || "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

      // Globals setzen
      window.mpl_token_metadata = TM;
      window.mplTokenMetadata   = TM;
      window.metaplex = window.metaplex || {};
      window.metaplex.mplTokenMetadata = TM;

      console.log("[vendor] mpl-token-metadata UMD loaded", {
        programId: String(TM.PROGRAM_ID),
        hasV3: !!TM.createCreateMetadataAccountV3Instruction
      });
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      console.warn("[vendor] load failed:", String(e?.message || e));
    }
  }

  if (!ok) {
    throw lastErr || new Error("All UMD candidates failed for mpl-token-metadata");
  }
})();