/* webOS TV remote key codes (Magic Remote and classic remotes alike),
   verified on webOS TV 4.x-7.x. Keyboard aliases are for browser debugging. */
window.KEY = {
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  ENTER: 13,
  BACK: 461,          // only delivered when appinfo.json has "disableBackHistoryAPI": true
  INFO: 457,
  RED: 403,
  GREEN: 404,
  YELLOW: 405,
  BLUE: 406,
  CH_UP: 33,
  CH_DOWN: 34,
  // keyboard aliases for desktop debugging
  KB_ESC: 27,
  KB_M: 77
};

/* Map remote and keyboard codes onto a single set of actions. */
window.keyAction = function (code) {
  var K = window.KEY;
  switch (code) {
    case K.LEFT: return 'left';
    case K.UP: return 'up';
    case K.RIGHT: return 'right';
    case K.DOWN: return 'down';
    case K.ENTER: return 'enter';
    case K.BACK:
    case K.KB_ESC: return 'back';
    case K.YELLOW:
    case K.KB_M: return 'menu';
    case K.RED: return 'red';
    case K.GREEN: return 'green';
    case K.BLUE: return 'blue';
    case K.INFO: return 'info';
    default: return null;
  }
};
