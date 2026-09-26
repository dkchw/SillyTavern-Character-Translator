# SillyTavern Character Translator

A powerful SillyTavern UI extension that duplicates and translates character cards into any target language using your connected LLM.

---

## Features

- **Character Card Cloning**: Automatically clones the character avatar and metadata structure without modifying or overwriting your original character.
- **Full Field Translation**: Translates all character fields:
  - Character Name
  - Description
  - Personality
  - Scenario
  - First Message / Greeting
  - Dialogue Examples (`mes_example`)
  - Alternate Greetings
  - System Prompts & Post-History Instructions
  - Creator Notes
- **Tag & Macro Preservation**: Preserves critical SillyTavern tags, formatting, and macros (`{{char}}`, `{{user}}`, `{{original}}`, `<START>`).
- **Flexible Language Selection**: Supports Japanese, Spanish, French, German, Chinese (Simplified/Traditional), Korean, Russian, Italian, Portuguese, Vietnamese, Arabic, and custom languages.
- **Convenient UI Access**:
  - One-click button in the Character Management drawer.
  - Dedicated control panel in the Extensions settings drawer.
  - STscript slash command: `/translate-character`.

---

## Installation

### Method 1: SillyTavern Extension Manager (URL Install)
1. In SillyTavern, open the **Extensions** menu (stacked blocks icon).
2. Click **Install Extension**.
3. Paste the repository URL:
   ```
   https://github.com/dkchw/SillyTavern-Character-Translator
   ```
4. Click **Save** and reload SillyTavern.

### Method 2: Manual Git Clone
Clone into your SillyTavern `third-party` extensions folder:
```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone https://github.com/dkchw/SillyTavern-Character-Translator.git
```

---

## Usage

1. Open the Character Translator via the **Extensions panel** or the globe/language icon in the **Character Management** drawer.
2. Select the character you want to translate.
3. Select your target language and choose an optional name suffix (e.g. `[JA]`).
4. Check the fields you want to translate.
5. Click **Translate & Clone**. The extension will clone the card, translate each field sequentially with your active model, save the new card, and automatically switch to it!

---

## License

MIT License. See [LICENSE](LICENSE) for details.
