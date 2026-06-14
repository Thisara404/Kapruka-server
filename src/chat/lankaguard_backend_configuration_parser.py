# -*- coding: utf-8 -*-
"""
LankaGuard Backend Utility Module
Provides:
  1. Deep dictionary sets for Singlish and Tanglish detection
  2. Local regex and token parsing logic
  3. The strict "Antigravity" system prompt generator
"""

import re
from typing import Dict, Any, List, Set

# This dataset captures common pronouns, grammar markers, action verbs, interrogatives, and conversational slang in Romanized Sinhala.
SINGLISH_WORDS: Set[str] = {
    # Greetings & Common Polite Words
    "kohomada", "subha", "dawasak", "ayubowan", "halow", "isthuthi", "sthuthi", "karunakarala",
    
    # Pronouns & People
    "oyata", "mata", "eyata", "api", "oyala", "mam", "mama", "oya", "eya", "meya", "thama", "un", "ogolla",
    "machan", "malli", "nangi", "aiya", "akka", "amma", "thaththa", "yaluwa", "mithraya", "thambi",
    
    # Verbs & Action Words (Common colloquial forms)
    "karanne", "karanna", "karapan", "yanne", "yanna", "yapan", "enna", "enawa", "yanawa", "innawa", 
    "inna", "innada", "kanawa", "kanne", "kanna", "bonawa", "bonne", "bonna", "kiyanna", "kiyanna", 
    "kiyapan", "hadanna", "hadanawa", "puluwan", "puluwanda", "baha", "ba", "be", "baha", "nathnam",
    "awilla", "gihin", "balanna", "balanawa", "danna", "dananawa", "dapan", "damma", "ganna", "gannawa",
    
    # Interrogatives (Questions)
    "mokada", "monada", "kauda", "mokatada", "koheda", "kohomad", "mokakda", "kauda", "ai", "moko",
    
    # Adjectives & Particles & Conversational Fillers
    "hari", "ne", "naha", "na", "neda", "neda", "ane", "anei", "mey", "me", "mokut", "monawahari",
    "dan", "wela", "velawa", "heta", "ada", "iyye", "thawa", "ithiri", "godak", "chuttak", "poddak",
    "ela", "patta", "supiri", "maru", "nikan", "awlak", "aulak", "niyamai", "sira", "sirawatama"
}

# This dataset captures colloquial Romanized Tamil pronouns, verbs, greetings, and common slang used in conversational mixtures.
TANGLISH_WORDS: Set[str] = {
    # Greetings & Polite expressions
    "vanakkam", "nandri", "hello", "hi", "varuga", "saranam",
    
    # Pronouns & People
    "enaku", "unaku", "avan", "ava", "naan", "nee", "enga", "nanga", "avanga", "ivanga", "ungaluku",
    "macha", "machi", "thambi", "anna", "akka", "thala", "nanba", "nanbi", "maama", "mami", "muttal",
    
    # Verbs & Common Actions
    "irukenga", "irukinga", "irukira", "iruku", "irukan", "poda", "ponga", "vanga", "va", "po", 
    "saptiya", "sapadu", "sollu", "sollunga", "panrenga", "panringa", "varatuma", "varum", "illai", 
    "ama", "irukku", "poidu", "seyya", "panni", "kelu", "ketingala",
    
    # Interrogatives
    "enna", "epdi", "yaaru", "yenna", "yean", "eppo", "enga", "edhu", "eppadi", "ethana",
    
    # Conversational Modifiers & Slang
    "super", "semma", "romba", "nalla", "kuda", "vada", "seri", "apdiya", "paravala", "konjam", 
    "miga", "vegam", "pathu", "theriyum", "theriyathu"
}

def detect_input_profile(text: str) -> Dict[str, Any]:
    """
    Analyzes raw input text locally before running any AI request.
    Identifies Unicode presence and matches Romanized tokens against local word lists.
    """
    if not text or not text.strip():
        return {
            "verdict": "EMPTY",
            "has_sinhala_unicode": False,
            "has_tamil_unicode": False,
            "matched_singlish_count": 0,
            "matched_tanglish_count": 0,
            "matched_words": []
        }

    # 1. Inspect Native Scripts via Unicode Ranges
    # Sinhala Unicode range: U+0D80 to U+0DFF
    has_sinhala_unicode = bool(re.search(r"[\u0D80-\u0DFF]", text))
    # Tamil Unicode range: U+0B80 to U+0BFF
    has_tamil_unicode = bool(re.search(r"[\u0B80-\u0BFF]", text))

    # 2. Parse, Clean and Tokenize English Text
    clean_text = re.sub(r"[^\w\s]", "", text.lower())
    tokens = set(clean_text.split())

    # 3. Match against lists
    matched_singlish = tokens.intersection(SINGLISH_WORDS)
    matched_tanglish = tokens.intersection(TANGLISH_WORDS)

    # 4. Apply strict classification priority rules
    if has_sinhala_unicode:
        verdict = "SINHALA_NATIVE"
    elif has_tamil_unicode:
        verdict = "TAMIL_NATIVE"
    elif len(matched_singlish) > len(matched_tanglish) and len(matched_singlish) > 0:
        verdict = "SINGLISH_ROMANIZED"
    elif len(matched_tanglish) > 0:
        verdict = "TANGLISH_ROMANIZED"
    else:
        verdict = "STANDARD_ENGLISH"

    return {
        "verdict": verdict,
        "has_sinhala_unicode": has_sinhala_unicode,
        "has_tamil_unicode": has_tamil_unicode,
        "matched_singlish_count": len(matched_singlish),
        "matched_tanglish_count": len(matched_tanglish),
        "matched_words": list(matched_singlish.union(matched_tanglish))
    }

def get_antigravity_prompt(profile: Dict[str, Any]) -> str:
    """
    Generates a system guardrail instruction based on the pre-processed input profile.
    This is passed to the AI to prevent illegal language leakage (Singlish / Tanglish).
    """
    verdict = profile["verdict"]
    
    # Build contextual instructions based on what we detected
    if verdict == "SINGLISH_ROMANIZED":
        context_guidance = (
            "CRITICAL: The user has written in 'Singlish' (Sinhala written in Romanized characters). "
            "You MUST translate their intent internally and respond ONLY in native Sinhala script (සිංහල අකුරෙන්). "
            "Under no circumstances should you reply back in Singlish (e.g. do NOT write 'kohomada', 'oya', 'ithiri')."
        )
    elif verdict == "TANGLISH_ROMANIZED" or verdict == "TAMIL_NATIVE":
        context_guidance = (
            "CRITICAL: The user has inputted Tamil or Tanglish context. "
            "Because this platform is structurally locked to Sinhala or English only, you must translation-shift. "
            "Respond ONLY in standard high-quality English, or native Sinhala script (සිංහල). Do NOT respond in Tamil/Tanglish."
        )
    elif verdict == "SINHALA_NATIVE":
        context_guidance = (
            "The user has written in native Sinhala script. Your output must strictly be in native Sinhala script (සිංහල) "
            "or standard English. Prefer native Sinhala Unicode script."
        )
    else:
        context_guidance = (
            "The user has written in standard English. You are authorized to reply in standard English "
            "or native Sinhala Unicode script (සිංහල)."
        )

    # Master "Antigravity" Prompt enforcing strict linguistic confinement
    antigravity_master_prompt = f"""You are Antigravity, a high-performance bilingual LLM controller locked to the Sri Lankan localized ecosystem.

### STRICT OPERATIONAL PRINCIPLES (UNBREAKABLE):
1. **PERMITTED WRITING DIALECTS**:
   - You are ONLY allowed to output text in **Pure Native Sinhala Unicode Script (සිංහල අකුරු)** or **Standard High-Quality English**.
   
2. **STRICTLY FORBIDDEN DIALECTS**:
   - NEVER, under any circumstance, write in Romanized Sinhala (Singlish, e.g., "oyata kohomada machan", "subha dawasak", "naha").
   - NEVER, under any circumstance, write in Romanized Tamil (Tanglish, e.g., "vanakkam", "epdi irukinga", "thambi").
   - Any output containing Singlish or Tanglish violates safety controls and triggers a system crash.

### SESSION LINGUISTIC DIRECTIVE:
{context_guidance}

Execute this response with professional translation accuracy, fully adhering to the structural output guardrails."""

    return antigravity_master_prompt


if __name__ == "__main__":
    # Test cases to evaluate accuracy
    test_inputs = [
        "oyata kohomada machan? ada heta hamuwemu neda?", # Singlish
        "ඔයාට කොහොමද? මම සුවෙන් ඉන්නවා.",                 # Pure Sinhala
        "vanakkam thambi, epdi irukinga? saptiya super ah?", # Tanglish
        "Could you please show me the tourist destinations in Kandy?" # English
    ]
    
    print("=== LANKAGUARD BACKEND PIPELINE SIMULATOR ===\n")
    for user_text in test_inputs:
        print(f"Input Text: \"{user_text}\"")
        profile = detect_input_profile(user_text)
        print(f"-> Detected Profile: {profile['verdict']}")
        print(f"-> Matched Words: {profile['matched_words']}")
        
        # Generate System Prompt for this cycle
        system_prompt = get_antigravity_prompt(profile)
        print("-> Dynamic System Prompt Generated:")
        # Display just the context guidance block for visibility
        for line in system_prompt.split('\n'):
            if "CRITICAL:" in line or "The user" in line:
                print(f"   [Instruction Flag] {line}")
        print("-" * 60)