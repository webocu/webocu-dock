/* =========================================================================
   Confirmation dialog for destructive actions (restart, power off).
   Cancel is focused by default on purpose: a stray OK press must not
   reboot the TV. The dock's own Power Off / Restart ask for the opposite, as the
   TV's own power prompt does: a countdown (opts.seconds) with the action focused,
   which runs the action when it reaches zero unless the person moves to Cancel.
   ========================================================================= */
window.Dialog = (function () {
  var elRoot = document.getElementById('dialog');
  var elText = document.getElementById('dialogText');
  var elCancel = document.getElementById('dialogCancel');
  var elConfirm = document.getElementById('dialogConfirm');

  var isOpen = false;
  var focusIndex = 0;            // 0 = cancel, 1 = confirm
  var onConfirm = null;
  var onClose = null;
  var timer = null;              // the countdown, when the dialog has one
  var baseText = '';             // the plain question, shown once the countdown is stopped
  var opts = null;

  function paint() {
    elCancel.textContent = window.I18N.t('dialog.cancel');
    elConfirm.textContent = (opts && opts.confirmText) || window.I18N.t('dialog.confirm');
    elCancel.className = 'dialog__btn' + (focusIndex === 0 ? ' is-focused' : '');
    elConfirm.className = 'dialog__btn dialog__btn--danger' + (focusIndex === 1 ? ' is-focused' : '');
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* The person moved to Cancel: nothing runs by itself any more, and the text
     goes back to the plain question instead of a number that no longer counts. */
  function stopCountdown() {
    if (!timer) return;
    stopTimer();
    elText.textContent = baseText;
  }

  /* options (all optional): focus: 1 puts the focus on the action instead of
     Cancel; confirmText: the label of the action; seconds + tick(n): a countdown
     whose text is tick(seconds left), the action runs at zero; moving to Cancel
     stops it and shows `message` again. */
  function show(message, confirmCallback, closeCallback, options) {
    stopTimer();
    isOpen = true;
    opts = options || null;
    focusIndex = opts && opts.focus === 1 ? 1 : 0;
    onConfirm = confirmCallback || null;
    onClose = closeCallback || null;
    baseText = message;
    elText.textContent = message;
    elRoot.classList.add('is-open');
    elRoot.setAttribute('aria-hidden', 'false');
    paint();
    if (opts && opts.seconds > 0 && opts.tick) {
      var left = opts.seconds;
      elText.textContent = opts.tick(left);
      timer = setInterval(function () {
        left--;
        if (left > 0) { elText.textContent = opts.tick(left); return; }
        stopTimer();
        focusIndex = 1;
        accept();
      }, 1000);
    }
  }

  function hide() {
    if (!isOpen) return;
    stopTimer();
    isOpen = false;
    opts = null;
    elRoot.classList.remove('is-open');
    elRoot.setAttribute('aria-hidden', 'true');
    var callback = onClose;
    onConfirm = null;
    onClose = null;
    if (callback) callback();
  }

  function accept() {
    var callback = onConfirm;
    var confirmed = (focusIndex === 1);
    hide();
    if (confirmed && callback) callback();
  }

  /* Returns true when the key was consumed. */
  function handleKey(action) {
    if (!isOpen) return false;
    switch (action) {
      case 'left': focusIndex = 0; stopCountdown(); paint(); return true;
      case 'right': focusIndex = 1; paint(); return true;
      case 'enter': accept(); return true;
      case 'back': hide(); return true;
      default: return true;      // swallow everything else while modal
    }
  }

  elCancel.addEventListener('click', function () { focusIndex = 0; accept(); }, false);
  elConfirm.addEventListener('click', function () { focusIndex = 1; accept(); }, false);
  elCancel.addEventListener('mouseover', function () { focusIndex = 0; stopCountdown(); paint(); }, false);
  elConfirm.addEventListener('mouseover', function () { focusIndex = 1; paint(); }, false);

  return {
    show: show,
    hide: hide,
    isOpen: function () { return isOpen; },
    handleKey: handleKey,
    repaint: paint
  };
})();
