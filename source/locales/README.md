# Localization Files

This directory contains separate translation files for each supported language.

## Structure

Each language has its own file: `{lang}.js` where `{lang}` is the two-letter language code.

Currently supported languages:
- `en.js` - English (required as fallback)
- `ru.js` - Russian (Русский)
- `de.js` - German (Deutsch)
- `fr.js` - French (Français)
- `es.js` - Spanish (Español)
- `pt.js` - Portuguese (Português)
- `pl.js` - Polish (Polski)
- `uk.js` - Ukrainian (Українська)
- `sr.js` - Serbian (Српски)
- `hr.js` - Croatian (Hrvatski)
- `bg.js` - Bulgarian (Български)
- `zh.js` - Chinese Simplified (简体中文)

## File Format

Each locale file follows this structure:

```javascript
/* {LANG} locale for WebOCU Dock */
window.I18N_LOCALES = window.I18N_LOCALES || {};
window.I18N_LOCALES['{lang}'] = {
  'key.name': 'Translated text',
  'another.key': 'Another translation',
  // ...
};
```

## Enabling/Disabling Languages

To enable or disable languages, edit `source/index.html`:

1. **To disable a language**: Comment out its `<script>` tag in the locale loading section
2. **To enable a language**: Uncomment its `<script>` tag

Example:
```html
<!-- Locale files: comment out languages you don't need -->
<script src="locales/en.js"></script>
<script src="locales/ru.js"></script>
<!-- <script src="locales/de.js"></script> --> <!-- German disabled -->
```

**Note**: English (`en.js`) must always be loaded as it serves as the fallback language.

## Adding a New Language

1. Create a new file `{lang}.js` in this directory
2. Copy the structure from an existing locale file
3. Translate all keys to the new language
4. Add a `<script>` tag for the new locale in `source/index.html`
5. Add the language name to all locale files under the `lang.{lang}` key

The language will automatically appear in the language selection menu.

## Size Considerations

Each locale file adds approximately 15-20KB to the page size. For bandwidth-constrained deployments:

1. Keep only the languages you need
2. Comment out unused languages in `index.html`
3. Run `make lint` to ensure all enabled languages are complete

## Linting

The build system automatically checks:
- All enabled languages have the same keys as English
- No language has extra keys not in English
- All keys used in JavaScript code exist in all languages

Run `make lint` to verify translations.
