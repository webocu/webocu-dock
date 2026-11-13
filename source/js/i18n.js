/* =========================================================================
   Minimal i18n. Code stays English; visible strings live in separate locale files.
   English is the language of a fresh install; the app switches only when the
   user picks another one in Settings -> Appearance (the TV locale is not
   followed).

   Locale files are loaded from source/locales/*.js and register themselves
   in window.I18N_LOCALES. Enable/disable languages by commenting out the
   corresponding <script> tag in index.html.
   ========================================================================= */
window.I18N = (function () {
  /* Locales are loaded from separate files into window.I18N_LOCALES.
     Each locale file adds its translations to I18N_LOCALES[lang]. */
  var dict = window.I18N_LOCALES || {};

  /* Available languages are determined dynamically from loaded locale files. */
  var availableLanguages = Object.keys(dict);

  /* Current language, default is English. */
  var currentLang = 'en';

  /* Format a string with {placeholder} values ({id}, {name}, {path} are the
     ones the app carries). The value goes in through a function, not as a
     replacement string: an app name comes from the TV, and a "$&" or "$1" in it
     would otherwise be read as a pattern instead of printed. */
  function format(template, values) {
    if (!template || !values) return template;
    var result = template;
    for (var key in values) {
      result = result.replace(new RegExp('\\{' + key + '\\}', 'g'), literal(values[key]));
    }
    return result;
  }

  function literal(value) {
    return function () { return String(value); };
  }

  /* Translate a key, or return the key itself if not found. */
  function t(key, values) {
    var lang = dict[currentLang];
    if (!lang) {
      console.warn('[i18n] Language not loaded: ' + currentLang);
      lang = dict['en'] || {};
    }
    var text = lang[key];
    if (typeof text === 'undefined') {
      console.warn('[i18n] Missing key: ' + key + ' (lang: ' + currentLang + ')');
      return key;
    }
    return values ? format(text, values) : text;
  }

  /* Switch to another language. Returns true if the language changed. */
  function setLang(lang) {
    var requested = String(lang);
    var resolved = dict[requested] ? requested : requested.toLowerCase().split(/[-_]/)[0];
    if (!dict[resolved]) {
      console.warn('[i18n] Language not available: ' + requested);
      return false;
    }
    if (resolved === currentLang) return false;
    currentLang = resolved;
    return true;
  }

  /* Get the list of available languages. */
  function getAvailableLanguages() {
    return availableLanguages.slice();
  }

  /* Check if a language is available. */
  function isLanguageAvailable(lang) {
    return availableLanguages.indexOf(lang) >= 0;
  }

  /* Get the current language. */
  function lang() {
    return currentLang;
  }

  return {
    t: t,
    setLang: setLang,
    getAvailableLanguages: getAvailableLanguages,
    isLanguageAvailable: isLanguageAvailable,
    lang: lang
  };
})();
