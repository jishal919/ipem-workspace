(function () {
  let dialogQueue = Promise.resolve();

  function enqueueDialog(options) {
    const result = dialogQueue.then(() => renderDialog(options));
    dialogQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function renderDialog(options) {
    return new Promise((resolve) => {
      const {
        type = 'confirm',
        title = type === 'alert' ? 'Notice' : 'Please confirm',
        message = '',
        confirmText = type === 'alert' ? 'OK' : 'Continue',
        cancelText = 'Cancel',
        defaultValue = '',
        placeholder = '',
        danger = false,
        required = false
      } = options;

      const overlay = document.createElement('div');
      overlay.className = 'ipem-dialog-overlay';
      overlay.setAttribute('role', 'presentation');

      const dialog = document.createElement('section');
      dialog.className = 'ipem-dialog';
      dialog.setAttribute('role', type === 'alert' ? 'alertdialog' : 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const heading = document.createElement('h2');
      heading.className = 'ipem-dialog-title';
      heading.textContent = title;
      const description = document.createElement('p');
      description.className = 'ipem-dialog-message';
      description.textContent = message;
      dialog.append(heading, description);

      let input = null;
      if (type === 'prompt') {
        input = document.createElement('input');
        input.className = 'ipem-dialog-input';
        input.type = 'text';
        input.value = defaultValue;
        input.placeholder = placeholder;
        input.autocomplete = 'off';
        dialog.appendChild(input);
      }

      const actions = document.createElement('div');
      actions.className = 'ipem-dialog-actions';
      if (type !== 'alert') {
        const cancelButton = document.createElement('button');
        cancelButton.className = 'ipem-dialog-button ipem-dialog-cancel';
        cancelButton.type = 'button';
        cancelButton.textContent = cancelText;
        actions.appendChild(cancelButton);
        cancelButton.addEventListener('click', () => finish(type === 'prompt' ? null : false));
      }

      const confirmButton = document.createElement('button');
      confirmButton.className = `ipem-dialog-button ipem-dialog-confirm${danger ? ' is-danger' : ''}`;
      confirmButton.type = 'button';
      confirmButton.textContent = confirmText;
      actions.appendChild(confirmButton);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      let finished = false;
      const previousFocus = document.activeElement;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        resolve(value);
      };
      const submit = () => {
        if (type === 'prompt') {
          const value = input.value;
          if (required && !value.trim()) {
            input.focus();
            return;
          }
          finish(value);
        } else {
          finish(true);
        }
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape' && type !== 'alert') {
          event.preventDefault();
          finish(type === 'prompt' ? null : false);
        } else if (event.key === 'Enter' && type === 'prompt') {
          event.preventDefault();
          submit();
        } else if (event.key === 'Tab') {
          const focusable = Array.from(dialog.querySelectorAll('button, input'));
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      };

      confirmButton.addEventListener('click', submit);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay && type !== 'alert') finish(type === 'prompt' ? null : false);
      });
      document.addEventListener('keydown', onKeyDown, true);
      requestAnimationFrame(() => (input || confirmButton).focus());
    });
  }

  window.ipemDialog = Object.freeze({
    alert(message, options = {}) {
      return enqueueDialog({ ...options, type: 'alert', message: String(message ?? '') });
    },
    confirm(message, options = {}) {
      return enqueueDialog({ ...options, type: 'confirm', message: String(message ?? '') });
    },
    prompt(message, options = {}) {
      return enqueueDialog({ ...options, type: 'prompt', message: String(message ?? '') });
    }
  });
})();
