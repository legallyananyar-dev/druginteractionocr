(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MAX_DRUGS = 8;
  var MAX_FILE_MB = 25;
  var MAX_PDF_PAGES = 6;
  var NAME_RE = /^[a-z0-9][a-z0-9 -]{0,38}[a-z0-9]$/;
  var SEV_LABEL = { MAJOR: 'Major', MODERATE: 'Moderate', MINOR: 'Minor', UNKNOWN: 'Unclassified', NONE: 'None found' };
  var SEV_EMOJI = { MAJOR: '🔴', MODERATE: '🟡', MINOR: '🟢', UNKNOWN: '⚪', NONE: '🔵' };

  var drugs = [];
  var lastResult = null;
  var drugDataPromise = null;
  var workerPromise = null;
  var busy = false;
  var objectUrls = [];

  var el = {
    drop: $('drop'), file: $('file'), cam: $('cam'), pick: $('pick'), snap: $('snap'),
    files: $('files'), progress: $('progress'), bar: $('bar'), status: $('status'),
    chips: $('chips'), addForm: $('add-form'), addInput: $('add-input'),
    check: $('check'), example: $('example'), clear: $('clear'), results: $('results'),
  };

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function setStatus(msg, isErr) {
    el.status.textContent = msg || '';
    el.status.className = 'status' + (isErr ? ' err' : '');
  }
  function setProgress(p) {
    if (p == null) { el.progress.hidden = true; el.bar.style.width = '0'; return; }
    el.progress.hidden = false;
    el.bar.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
  }
  function lockUi(on) {
    busy = on;
    [el.pick, el.snap, el.example, el.clear, el.check].forEach(function (b) { b.disabled = on; });
    if (!on) el.check.disabled = drugs.length < 2;
  }

  function loadDrugData() {
    if (!drugDataPromise) {
      drugDataPromise = fetch('/drugs.json').then(function (r) {
        if (!r.ok) throw new Error('Could not load the drug list.');
        return r.json();
      });
      drugDataPromise.catch(function () { drugDataPromise = null; });
    }
    return drugDataPromise;
  }

  /* ---------- drug chips ---------- */
  function renderChips() {
    if (!drugs.length) {
      el.chips.innerHTML = '<span class="empty">No drugs yet. Insert a report above or add names below.</span>';
    } else {
      el.chips.innerHTML = drugs.map(function (d, i) {
        return '<span class="chip">' + esc(d) +
          '<button type="button" data-i="' + i + '" aria-label="Remove ' + esc(d) + '">×</button></span>';
      }).join('');
    }
    el.check.disabled = busy || drugs.length < 2;
  }

  function addDrug(raw) {
    var n = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!NAME_RE.test(n)) return 'invalid';
    if (drugs.indexOf(n) !== -1) return 'dup';
    if (drugs.length >= MAX_DRUGS) return 'full';
    drugs.push(n);
    return 'ok';
  }

  /* ---------- reading files ---------- */
  function getWorker() {
    if (!workerPromise) {
      if (!window.Tesseract) {
        return Promise.reject(new Error('The text reader could not load. Check your connection and refresh.'));
      }
      workerPromise = window.Tesseract.createWorker('eng', 1, {
        logger: function (m) {
          if (m.status === 'recognizing text') setProgress(m.progress);
        },
      });
      workerPromise.catch(function () { workerPromise = null; });
    }
    return workerPromise;
  }

  // Downscale big phone photos and boost contrast: faster and usually more accurate OCR.
  function toCanvas(file, maxSide) {
    if (typeof createImageBitmap !== 'function') return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      var scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      var ctx = c.getContext('2d');
      ctx.filter = 'grayscale(1) contrast(1.35)';
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      return c;
    }).catch(function () { return file; });
  }

  function ocr(source) {
    return getWorker().then(function (w) { return w.recognize(source); })
      .then(function (r) { return r.data.text || ''; });
  }

  function readImage(file) {
    return toCanvas(file, 2200).then(ocr);
  }

  function readPdf(file, onPage) {
    return import('/vendor/pdfjs/pdf.min.mjs').then(function (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return file.arrayBuffer().then(function (buf) { return pdfjs.getDocument({ data: buf }).promise; });
    }).then(function (pdf) {
      var total = Math.min(pdf.numPages, MAX_PDF_PAGES);
      var out = [];
      var chain = Promise.resolve();
      var _loop = function (p) {
        chain = chain.then(function () {
          onPage(p, total);
          return pdf.getPage(p).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var text = tc.items.map(function (i) { return i.str; }).join(' ');
              if (text.replace(/\s/g, '').length >= 40) { out.push(text); return; }
              // scanned page with no text layer: render it and OCR the picture
              var viewport = page.getViewport({ scale: 2 });
              var c = document.createElement('canvas');
              c.width = viewport.width;
              c.height = viewport.height;
              return page.render({ canvasContext: c.getContext('2d'), viewport: viewport }).promise
                .then(function () { return ocr(c); })
                .then(function (t) { out.push(t); });
            });
          });
        });
      };
      for (var p = 1; p <= total; p++) _loop(p);
      return chain.then(function () { return out.join('\n'); });
    });
  }

  function addFileRow(file) {
    var li = document.createElement('li');
    var thumb = document.createElement('span');
    thumb.className = 'thumb';
    if (file.type.indexOf('image/') === 0) {
      var img = document.createElement('img');
      var url = URL.createObjectURL(file);
      objectUrls.push(url);
      img.src = url;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      thumb.textContent = '📄';
    }
    var name = document.createElement('span');
    name.className = 'fname';
    name.textContent = file.name;
    var state = document.createElement('span');
    state.className = 'fstate';
    state.textContent = 'Waiting';
    li.appendChild(thumb); li.appendChild(name); li.appendChild(state);
    el.files.appendChild(li);
    return function (text, cls) { state.textContent = text; state.className = 'fstate' + (cls ? ' ' + cls : ''); };
  }

  function validateFile(file) {
    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    var isImg = file.type.indexOf('image/') === 0;
    if (!isPdf && !isImg) return 'Unsupported file type';
    if (file.size > MAX_FILE_MB * 1024 * 1024) return 'Over ' + MAX_FILE_MB + ' MB';
    return null;
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length || busy) return;
    lockUi(true);
    setStatus('');
    var texts = [];
    var chain = loadDrugData().then(function (data) {
      var seq = Promise.resolve();
      files.forEach(function (file) {
        var setRow = addFileRow(file);
        seq = seq.then(function () {
          var problem = validateFile(file);
          if (problem) { setRow(problem, 'err'); return; }
          setRow('Reading…');
          setStatus('Reading ' + file.name + '… the first scan loads the text reader (a few seconds).');
          setProgress(0);
          var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
          var job = isPdf
            ? readPdf(file, function (p, total) { setRow('Page ' + p + ' of ' + total + '…'); })
            : readImage(file);
          return job.then(function (t) { texts.push(t); setRow('Read', 'ok'); })
            .catch(function (e) { setRow('Failed', 'err'); setStatus(e.message || 'Could not read that file.', true); });
        });
      });
      return seq.then(function () { return data; });
    });

    return chain.then(function (data) {
      setProgress(null);
      var found = window.DrugExtract.extractDrugs(texts.join('\n'), data);
      var added = 0, skipped = 0;
      found.forEach(function (n) {
        var r = addDrug(n);
        if (r === 'ok') added++; else if (r === 'full') skipped++;
      });
      renderChips();
      if (!texts.length) {
        if (!el.status.classList.contains('err')) setStatus('Nothing could be read from those files.', true);
      } else if (!found.length) {
        setStatus('No known drug names found. Try a flatter, brighter, closer photo, or add names manually below.', true);
      } else {
        setStatus('Found ' + found.length + ' drug name' + (found.length > 1 ? 's' : '') + ': ' + found.join(', ') +
          '.' + (skipped ? ' Only ' + MAX_DRUGS + ' drugs can be checked at once.' : ' Confirm they match your report.'));
      }
    }).catch(function (e) {
      setProgress(null);
      setStatus(e.message || 'Something went wrong.', true);
    }).then(function () {
      lockUi(false);
      if (drugs.length >= 2 && texts.length) runCheck();
    });
  }

  /* ---------- checking ---------- */
  function runCheck() {
    if (busy || drugs.length < 2) return;
    lockUi(true);
    el.results.hidden = false;
    el.results.innerHTML = '<h2 id="s3"><span class="step">3</span> Results</h2>' +
      '<div class="loading"><span class="spin"></span> Looking up RxNorm and FDA labels…</div>';
    el.results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    return fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drugs: drugs }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw new Error(json.error || 'Request failed (' + res.status + ').');
        return json;
      });
    }).then(function (result) {
      lastResult = result;
      renderResults(result);
    }).catch(function (e) {
      el.results.innerHTML = '<h2 id="s3"><span class="step">3</span> Results</h2>' +
        '<div class="err-box">' + esc(e.message || 'Could not reach the server.') + '</div>';
    }).then(function () { lockUi(false); });
  }

  function highlight(text, term) {
    var safe = esc(text);
    if (!term) return safe;
    return safe.replace(new RegExp('(' + escRe(esc(term)) + '(?:s|es)?)', 'ig'), '<mark>$1</mark>');
  }

  function renderResults(r) {
    var s = r.summary;
    var hi = s.highest;
    var msg = s.pairsWithMention
      ? s.pairsWithMention + ' of ' + s.pairsChecked + ' pair' + (s.pairsChecked > 1 ? 's' : '') +
        ' mention each other in FDA label text.'
      : 'None of the ' + s.pairsChecked + ' pair' + (s.pairsChecked > 1 ? 's' : '') +
        ' mention each other in the label text we could read. This does not prove they are safe together.';
    var html = '<h2 id="s3"><span class="step">3</span> Results</h2>' +
      '<div class="banner sev-' + hi + '"><span class="big" aria-hidden="true">' + SEV_EMOJI[hi] + '</span><div>' +
      '<h2>' + (hi === 'NONE' ? 'No cross-mentions found' : 'Highest severity: ' + SEV_LABEL[hi]) + '</h2>' +
      '<p>' + esc(msg) + '</p></div></div>';

    html += '<div class="tags">' + r.resolved.map(function (d) {
      var tail = d.rxcui ? 'RxCUI ' + esc(d.rxcui) : 'not in RxNorm';
      return '<span class="tag"><b>' + esc(d.name) + '</b> · ' + tail + '</span>';
    }).join('') + '</div>';

    if (r.interactions.length) {
      html += '<h3>Mentioned in FDA label text</h3>';
      r.interactions.forEach(function (p) {
        html += '<div class="pair sev-' + p.severity + '"><div class="pair-head"><strong>' +
          esc(p.drugs[0]) + ' + ' + esc(p.drugs[1]) + '</strong><span class="badge">' +
          SEV_EMOJI[p.severity] + ' ' + SEV_LABEL[p.severity].toUpperCase() + '</span></div>';
        p.evidence.forEach(function (e) {
          html += '<p class="ev">From the <b>' + esc(e.from) + '</b> label (mentions ' + esc(e.mentions) + '):' +
            '<q>…' + highlight(e.text, e.matchedTerm) + '…</q></p>';
        });
        html += '</div>';
      });
    }

    if (r.noMention.length) {
      html += '<h3>No cross-mention found</h3><ul class="nomention">' + r.noMention.map(function (p) {
        return '<li>' + esc(p[0]) + ' + ' + esc(p[1]) + '</li>';
      }).join('') + '</ul>';
    }

    if (r.notes.length) {
      html += '<div class="notes"><strong>Heads up</strong><ul>' + r.notes.map(function (n) {
        return '<li>' + esc(n) + '</li>';
      }).join('') + '</ul></div>';
    }

    var withText = r.labels.filter(function (l) { return l.excerpt; });
    if (withText.length) {
      html += '<details><summary>FDA label excerpts</summary>' + withText.map(function (l) {
        return '<div class="label-ex"><strong>' + esc(l.drug) + '</strong><br>' + esc(l.excerpt) + '</div>';
      }).join('') + '</details>';
    }

    html += '<div class="row actions">' +
      '<button type="button" class="btn" id="dl-csv">Download CSV</button>' +
      '<button type="button" class="btn" id="dl-json">Download JSON</button>' +
      '<button type="button" class="btn" id="print">Print</button></div>' +
      '<p class="muted">Checked ' + esc(new Date(s.checkedAt).toLocaleString()) + '. Severity is keyword-based, not a clinical rating.</p>';

    el.results.innerHTML = html;
    $('dl-csv').addEventListener('click', downloadCsv);
    $('dl-json').addEventListener('click', downloadJson);
    $('print').addEventListener('click', function () { window.print(); });
  }

  /* ---------- exports ---------- */
  function save(name, mime, content) {
    var url = URL.createObjectURL(new Blob([content], { type: mime }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function csvCell(v) { return '"' + String(v).replace(/"/g, '""').replace(/\s+/g, ' ') + '"'; }
  function downloadCsv() {
    if (!lastResult) return;
    var rows = [['drug_a', 'drug_b', 'pair_severity', 'evidence_from', 'evidence_severity', 'evidence_text']];
    lastResult.interactions.forEach(function (p) {
      p.evidence.forEach(function (e) { rows.push([p.drugs[0], p.drugs[1], p.severity, e.from, e.severity, e.text]); });
    });
    lastResult.noMention.forEach(function (p) { rows.push([p[0], p[1], 'NONE', '', '', 'No cross-mention found in label text']); });
    save('interactions.csv', 'text/csv', rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n'));
  }
  function downloadJson() {
    if (lastResult) save('interactions.json', 'application/json', JSON.stringify(lastResult, null, 2));
  }

  /* ---------- wiring ---------- */
  el.pick.addEventListener('click', function (e) { e.stopPropagation(); el.file.click(); });
  el.snap.addEventListener('click', function (e) { e.stopPropagation(); el.cam.click(); });
  el.drop.addEventListener('click', function () { if (!busy) el.file.click(); });
  el.drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!busy) el.file.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (t) {
    el.drop.addEventListener(t, function (e) { e.preventDefault(); el.drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    el.drop.addEventListener(t, function (e) { e.preventDefault(); el.drop.classList.remove('over'); });
  });
  el.drop.addEventListener('drop', function (e) { handleFiles(e.dataTransfer && e.dataTransfer.files); });
  [el.file, el.cam].forEach(function (input) {
    input.addEventListener('change', function () {
      var list = Array.prototype.slice.call(input.files);
      input.value = '';          // allow choosing the same file again
      handleFiles(list);
    });
  });

  el.chips.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-i]');
    if (!b || busy) return;
    drugs.splice(Number(b.getAttribute('data-i')), 1);
    renderChips();
  });

  el.addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var r = addDrug(el.addInput.value);
    if (r === 'ok') { el.addInput.value = ''; setStatus(''); renderChips(); }
    else if (r === 'dup') setStatus('That drug is already in the list.', true);
    else if (r === 'full') setStatus('You can check up to ' + MAX_DRUGS + ' drugs at once.', true);
    else setStatus('Use letters, numbers, spaces or hyphens only (2 to 40 characters).', true);
  });

  el.check.addEventListener('click', runCheck);
  el.example.addEventListener('click', function () {
    drugs = ['warfarin', 'aspirin'];
    setStatus('Example loaded.');
    renderChips();
    runCheck();
  });
  el.clear.addEventListener('click', function () {
    drugs = [];
    lastResult = null;
    el.files.innerHTML = '';
    objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    objectUrls = [];
    el.results.hidden = true;
    el.results.innerHTML = '';
    setStatus('');
    renderChips();
  });

  renderChips();
  loadDrugData();   // warm the cache

  // exposed for tests
  window.__app = { addDrug: addDrug, renderChips: renderChips, handleFiles: handleFiles, getDrugs: function () { return drugs.slice(); } };
})();
