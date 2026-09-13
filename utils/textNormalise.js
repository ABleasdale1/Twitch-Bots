// utils/textNormalise.js

// Converts common Unicode lookalike letters into normal Latin letters.
// This helps catch bypasses using Cyrillic/Greek characters that visually look English.
function replaceHomoglyphs(text) {
  const map = {
    // Latin weird variants
    "ß": "b",
    "ø": "o",
    "ð": "d",
    "đ": "d",
    "¥": "y",
    "₱": "p",
    "£": "l",

    // Cyrillic lookalikes
    "а": "a",
    "е": "e",
    "о": "o",
    "р": "p",
    "с": "c",
    "у": "y",
    "х": "x",
    "і": "i",
    "ї": "i",
    "ӏ": "l",

    // Greek lookalikes
    "α": "a",
    "β": "b",
    "ε": "e",
    "ζ": "z",
    "η": "h",
    "ι": "i",
    "κ": "k",
    "μ": "m",
    "ν": "n",
    "ο": "o",
    "ρ": "p",
    "τ": "t",
    "χ": "x",
  };

  return [...text].map((char) => map[char] || char).join("");
}

// Creates several normalised versions of the message.
// This catches spaces, punctuation, leetspeak, accents, homoglyphs, and common phonetic variants.
function makeNormalizedVariants(input) {
  let base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  // Replace Cyrillic/Greek/lookalike letters with normal Latin letters.
  base = replaceHomoglyphs(base);

  // Convert common symbol substitutions.
  const symbolFixed = base
    .replace(/!/g, "i")
    .replace(/\|/g, "l")
    .replace(/\$/g, "s")
    .replace(/@/g, "a")
    .replace(/£/g, "l")
    .replace(/₱/g, "p")
    .replace(/€/g, "e");

  // Remove spaces, punctuation, emoji, etc.
  // Keeps only letters and numbers.
  const compact = symbolFixed.replace(/[^\p{L}\p{N}]/gu, "");

  // Convert basic leetspeak digits into letters.
  const leetCompact = compact
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b");

  // Convert common misspellings / phonetic variants.
  const phonetic = leetCompact
    // body variants
    .replace(/bodee/g, "body")
    .replace(/bodey/g, "body")
    .replace(/bodie/g, "body")
    .replace(/bohdee/g, "body")
    .replace(/bohdy/g, "body")
    .replace(/bawdy/g, "body")
    .replace(/bawdee/g, "body")
    .replace(/boady/g, "body")
    .replace(/boadie/g, "body")
    .replace(/boddy/g, "body")
    .replace(/boody/g, "body")
    .replace(/bodi/g, "body")
    .replace(/b0di/g, "body")

    // pillow variants
    .replace(/pilow/g, "pillow")
    .replace(/pill0w/g, "pillow")
    .replace(/pilloww/g, "pillow")
    .replace(/pillows/g, "pillow")
    .replace(/pellow/g, "pillow")
    .replace(/pylow/g, "pillow")
    .replace(/pyllow/g, "pillow")
    .replace(/pilloe/g, "pillow")
    .replace(/pilloh/g, "pillow")
    .replace(/piiow/g, "pillow")
    .replace(/pi11ow/g, "pillow")
    .replace(/p111ow/g, "pillow")
    .replace(/pillow/g, "pillow")
    .replace(/peelow/g, "pillow")
    .replace(/peel0w/g, "pillow")
    .replace(/peeloh/g, "pillow")
    .replace(/peeloe/g, "pillow")
    .replace(/peelo/g, "pillow")
    .replace(/peelowe/g, "pillow");

  // Collapse long repeated characters.
  // Example: "pillloooow" becomes closer to "pilow".
  const collapsedRepeats = phonetic.replace(/(.)\1{2,}/g, "$1");

  // Return unique variants only.
  return [...new Set([compact, leetCompact, phonetic, collapsedRepeats])];
}

// Standard Levenshtein edit distance.
// Counts how many insertions/deletions/substitutions are needed to turn a into b.
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[a.length][b.length];
}

// Checks whether any substring of text is within maxDistance edits of the target.
// Used for fuzzy matching typos and bypasses.
function containsNearSubstring(text, target, maxDistance) {
  const minLen = Math.max(1, target.length - maxDistance);
  const maxLen = target.length + maxDistance;

  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i <= text.length - len; i++) {
      const sub = text.slice(i, i + len);

      if (levenshtein(sub, target) <= maxDistance) {
        return true;
      }
    }
  }

  return false;
}

// Checks a message against the blocked term after generating multiple normalised versions.
function isBlockedVariant(input, target, maxDistance) {
  const variants = makeNormalizedVariants(input);

  for (const text of variants) {
    // Direct contains check.
    // Example: "bodypillows" contains "bodypillow".
    if (text.includes(target)) {
      return {
        blocked: true,
        reason: `contains ${target} after normalization: ${text}`,
      };
    }

    // Fuzzy substring check for typos/bypasses.
    // Example: "boddy pilow" can still match "bodypillow".
    if (containsNearSubstring(text, target, maxDistance)) {
      return {
        blocked: true,
        reason: `near match to ${target}: ${text}`,
      };
    }
  }

  return { blocked: false };
}

module.exports = {
  replaceHomoglyphs,
  makeNormalizedVariants,
  levenshtein,
  containsNearSubstring,
  isBlockedVariant,
};