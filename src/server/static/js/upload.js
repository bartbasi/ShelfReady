// Progressive help for the upload page. The page works without this file: the camera button and
// the file chooser both post a form. With it, every photo taken or chosen stays in a list, so
// one invoice can take several photos, each can be removed, and a second tap cannot send twice.
// No network calls, no storage, nothing leaves the page except the form itself.
(function () {
  'use strict';
  var form = document.querySelector('form[data-upload]');
  if (!form || typeof DataTransfer === 'undefined') return;

  var max = Number(form.getAttribute('data-max-files')) || 10;
  var maxBytes = (Number(form.getAttribute('data-max-file-mb')) || 20) * 1024 * 1024;
  var holder = form.querySelector('[data-holder]');
  var list = form.querySelector('[data-list]');
  var status = form.querySelector('[data-status]');
  var submit = form.querySelector('[data-submit]');
  var entries = [];
  var urls = [];

  function size(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function render() {
    list.textContent = '';
    urls.forEach(function (u) { URL.revokeObjectURL(u); });
    urls = [];
    entries.forEach(function (e, i) {
      var li = document.createElement('li');
      li.className = 'file-row';
      if (/^image\//.test(e.file.type) && /^(image\/jpeg|image\/png|image\/webp)$/.test(e.file.type)) {
        var img = document.createElement('img');
        var u = URL.createObjectURL(e.file);
        urls.push(u);
        img.src = u;
        img.alt = '';
        img.width = 56;
        img.height = 56;
        li.appendChild(img);
      } else {
        var kind = document.createElement('span');
        kind.className = 'file-kind';
        kind.textContent = /pdf/.test(e.file.type) ? 'PDF' : 'FILE';
        li.appendChild(kind);
      }
      var name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = (i + 1) + '. ' + e.file.name + ' (' + size(e.file.size) + ')';
      li.appendChild(name);
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'button-outline button-small';
      rm.textContent = 'Remove';
      rm.setAttribute('aria-label', 'Remove ' + e.file.name);
      rm.addEventListener('click', function () {
        e.input.remove();
        entries.splice(entries.indexOf(e), 1);
        render();
      });
      li.appendChild(rm);
      list.appendChild(li);
    });
    var tooMany = entries.length > max;
    var tooBig = entries.some(function (e) { return e.file.size > maxBytes; });
    var text = entries.length === 0 ? 'No photos or files yet.' : entries.length + (entries.length === 1 ? ' file ready.' : ' files ready.');
    if (tooMany) text += ' That is more than the limit of ' + max + '. Remove some.';
    if (tooBig) text += ' A file is over the size limit. Remove it.';
    status.textContent = text;
    status.className = tooMany || tooBig ? 'error' : 'hint';
    submit.disabled = tooMany || tooBig;
  }

  function take(input) {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    // All or nothing, so no file can be sent twice. First build a hidden box for each file, not yet
    // in the form. Then empty the visible box and check it is empty. Only then add the hidden ones.
    // If anything fails before that, they are thrown away and the visible box still holds the files.
    var made = [];
    try {
      files.forEach(function (file) {
        var dt = new DataTransfer();
        dt.items.add(file);
        var keep = document.createElement('input');
        keep.type = 'file';
        keep.name = 'files';
        keep.hidden = true;
        keep.tabIndex = -1;
        keep.files = dt.files;
        if (!keep.files || keep.files.length !== 1) throw new Error('could not keep the file');
        made.push({ input: keep, file: file });
      });
      input.value = '';
      if (input.files && input.files.length) throw new Error('could not empty the box');
    } catch (err) {
      // An old browser: leave the form as it is. It posts what the visible box holds, once.
      return;
    }
    made.forEach(function (e) {
      holder.appendChild(e.input);
      entries.push(e);
    });
    render();
  }

  form.querySelectorAll('input[data-take]').forEach(function (input) {
    input.addEventListener('change', function () { take(input); });
  });

  var label = submit.textContent;

  // Coming back with the Back button shows this page as it was left, with the button still
  // disabled from the last upload. Put it right again.
  window.addEventListener('pageshow', function () {
    submit.textContent = label;
    render();
  });

  form.addEventListener('submit', function (ev) {
    if (submit.disabled) { ev.preventDefault(); return; }
    // Once is enough: a second tap while a big upload runs would only start another one.
    window.setTimeout(function () {
      submit.disabled = true;
      submit.textContent = 'Uploading. Keep this page open.';
    }, 0);
  });

  render();
})();
