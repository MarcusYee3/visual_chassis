import { useState } from 'react';
import ServerForm from './components/Form/Form';
import ServerOverview from './pages/ServerOverview';
import E5E6Overview from './pages/E5E6Overview';
import LogFailurePanel from './components/LogFailurePanel/LogFailurePanel';
import ReportCart from './components/ReportCart/ReportCart';
import NavMenu from './components/NavMenu/NavMenu';
import { updateServer, diagnoseServer, precheckDiagnose } from './services/api';
import { getLoggableParts } from './utils/loggableParts';
import { mergeFaultsClient } from './utils/mergeFaults';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };

// Matches the Form/LogFailurePanel card language (dot-pattern background, subtle border, soft
// shadow) instead of the bare unstyled <p> tags this used to be — those read as loose, uncontained
// text floating below the form rather than a distinct status area.
const statusCardStyle = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  padding: '12px 14px',
  borderRadius: '6px',
  border: '1px solid #33405a',
  backgroundImage:
    'radial-gradient(circle at 3px 3px, rgba(168, 196, 232, 0.05) 0.5px, transparent 0.5px), linear-gradient(180deg, #1c2333 0%, #161b28 100%)',
  backgroundSize: '6px 6px, 100% 100%',
  boxShadow: '0 4px 14px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

// Human-readable loading text per {type:'confirm'} resumeParam, shown while the follow-up request
// (after the user says "yes") is in flight — keyed to match exactly what the server names in
// server/src/routes/diagnose.js's sendConfirm calls.
const RESUME_LOADING_LABELS = {
  bypassPowerState: 'Re-running the targeted check (server reports powered off)…',
  bypassHostnicCheck: 'Re-running the targeted check (HOSTNIC reports down)…',
  continueToDefault: 'Running the default diagnostic chain…',
  continueToUut: 'Running the normal diagnostic flow for the unit itself…',
};

const genericErrorStyle = {
  width: '100%',
  maxWidth: '740px',
  padding: '8px 14px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: '#ffd6d6',
  background: 'linear-gradient(180deg, #7a2020 0%, #5c1818 100%)',
  border: '1px solid #cc3333',
  borderRadius: '6px',
  boxShadow: '0 0 12px rgba(204,51,51,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
};

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [faults, setFaults] = useState(EMPTY_FAULTS);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState('');
  const [diagnoseStatus, setDiagnoseStatus] = useState('');
  const [flowNotice, setFlowNotice] = useState('');
  const [loadingNotice, setLoadingNotice] = useState('');
  const [logPanel, setLogPanel] = useState(null); // { serialNumber, parts, checkName, source }
  // Set from the diagnose stream's terminal event (see server/src/routes/diagnose.js's
  // E5_E6_MODEL_RE) — an E5-2c/E6-2c unit's Jira "Model" field routes it to a different chassis
  // layout page below instead of the default B300 visualizer.
  const [chassisModel, setChassisModel] = useState(null);
  const [isE5E6Chassis, setIsE5E6Chassis] = useState(false);
  const [serialNumber, setSerialNumber] = useState('');
  // Manual "report any part" flow (separate from LogFailurePanel's auto-detected-fault flow
  // above) — reportMode gates whether clicking a chassis part opens the report-confirm dialog
  // instead of that part's own normal click behavior (see ServerOverview.jsx/E5E6Overview.jsx).
  // Confirmed parts land in reportCart, which the user pushes to the log all at once.
  const [reportMode, setReportMode] = useState(false);
  const [reportCart, setReportCart] = useState([]);
  const [pendingReport, setPendingReport] = useState(null); // { partId, partLabel }

  const handlePartClick = (partId, partLabel) => setPendingReport({ partId, partLabel });
  const handleConfirmPending = () => {
    setReportCart((prev) => (prev.some((p) => p.partId === pendingReport.partId) ? prev : [...prev, pendingReport]));
    setPendingReport(null);
  };
  const handleCancelPending = () => setPendingReport(null);
  const handleRemoveFromCart = (partId) => setReportCart((prev) => prev.filter((p) => p.partId !== partId));

  const handleFormSubmit = async (formData) => {
    await updateServer('server-1', { serialNumber: formData.sn });
    setFaults(EMPTY_FAULTS);
    setRefreshKey((k) => k + 1);
    setLogPanel(null);
    setSerialNumber(formData.sn);
    setReportCart([]);
    setPendingReport(null);

    setDiagnosing(true);
    setDiagnoseError('');
    setDiagnoseStatus('');
    setFlowNotice('');
    setLoadingNotice('');
    setChassisModel(null);
    setIsE5E6Chassis(false);

    // The real diagnose request takes tens of seconds (ILOM SSH round-trips); precheck is a
    // near-instant read of the same decision it's about to make (mfg-collector cache, or the
    // supplied Jira ticket if given priority), so the loading state can show something specific
    // (e.g. "No mfg-collector record found...") in place of a generic "Running diagnostics…" the
    // whole time. Best-effort — if it fails for any reason, just fall back to the generic message
    // rather than blocking the real request on it.
    try {
      const precheck = await precheckDiagnose('server-1', formData.sn, formData.jiraLink);
      setLoadingNotice(precheck.targetedCheckName
        ? `Running targeted check: ${precheck.targetedCheckName}…`
        : (precheck.notice || 'Running diagnostics…'));
    } catch {
      setLoadingNotice('Running diagnostics…');
    }

    // Accumulated locally (not just via setFaults, which is async) so the final summary below —
    // logPanel's loggable parts, the "Faults detected" status text — can be computed the instant
    // the stream ends, against the complete picture, without waiting on an extra render cycle.
    let accumulated = EMPTY_FAULTS;
    // Every extra flag the user has agreed to so far (e.g. {bypassHostnicCheck: true}), resent on
    // every subsequent request — the server is stateless across requests, so a later request must
    // still carry every earlier confirm's answer, not just the newest one.
    const resumeFlags = { bypassPowerState: !!formData.bypassPowerState };

    // Runs one diagnose request (with the current resumeFlags) and returns whichever event ended
    // the stream ({type:'done'}, {type:'confirm'}, or {type:'fatal'}).
    const streamOnce = async () => {
      let terminalEvent = null;
      await diagnoseServer('server-1', formData.sn, formData.ilomIp, formData.jiraLink, resumeFlags, (event) => {
        if (event.type === 'partial') {
          // Merged into the running total and shown immediately — the default ILOM chain runs
          // many commands unconditionally and can take a while end-to-end, so faults already found
          // (e.g. a DIMM training failure from fmadm) show up on the chassis right away instead of
          // waiting on every remaining command, including any that time out, to finish first.
          accumulated = mergeFaultsClient(accumulated, event.faults);
          setFaults(accumulated);
          setLoadingNotice(`Checking ${event.label}…`);
        } else if (event.type === 'chassis') {
          // Not a terminal event — the stream keeps going after this. Applied the instant it
          // arrives (server sends it before any partial whenever possible) so the page switches to
          // E5E6Overview before a single fault renders on the wrong (default B300) page instead of
          // only at the very end, once the terminal event finally reveals the chassis type.
          setChassisModel(event.chassisModel || null);
          setIsE5E6Chassis(!!event.isE5E6Chassis);
        } else {
          if (event.type === 'fatal') setDiagnoseError(event.error);
          terminalEvent = event;
        }
      });
      return terminalEvent;
    };

    try {
      let terminalEvent = await streamOnce();

      // A single diagnosis can chain through several confirms — a targeted check may stop at more
      // than one bypassable gate in sequence (e.g. HOSTNIC down, then also power_state off once
      // HOSTNIC is bypassed), and once it finishes it always asks separately whether to also run
      // the default chain. Each "yes" adds that confirm's resumeParam to resumeFlags and re-runs;
      // any "no" stops the loop there, keeping whatever was found as final.
      while (terminalEvent?.type === 'confirm') {
        // eslint-disable-next-line no-alert -- matches the confirm-before-submit pattern already
        // used in Form.jsx; this is a deliberate blocking prompt, not an accidental one.
        const shouldContinue = window.confirm(terminalEvent.message);
        if (!shouldContinue) break;
        resumeFlags[terminalEvent.resumeParam] = true;
        setLoadingNotice(RESUME_LOADING_LABELS[terminalEvent.resumeParam] || 'Continuing…');
        terminalEvent = await streamOnce();
      }

      // Covers both a normal 'done' and a declined 'confirm' (nothing further was checked, but
      // whatever partials already arrived — usually none, since a confirm only fires when the
      // targeted check found nothing real — still deserve a status line). A 'fatal' is skipped
      // here since diagnoseError above already covers it.
      if (terminalEvent && terminalEvent.type !== 'fatal') {
        setFlowNotice(terminalEvent.defaultFlowNotice || (terminalEvent.type === 'confirm' ? terminalEvent.message : ''));
        // Only a real {type:'done'} carries chassisModel/isE5E6Chassis (see sendDone vs.
        // sendConfirm in diagnose.js) — a declined confirm's terminalEvent has neither field, so
        // unconditionally overwriting here with `terminalEvent.chassisModel || null` reset the
        // page back to B300 even when an earlier mid-stream {type:'chassis'} event (e.g. from the
        // Jira ticket's Model field, sent before CHECK_POWER_ON ever ran) had already correctly
        // identified an E5-2c/E6-2c unit. Only apply the terminal event's values when it's the one
        // event type that actually carries them — otherwise keep whatever the stream already set.
        if (terminalEvent.type === 'done') {
          setChassisModel(terminalEvent.chassisModel || null);
          setIsE5E6Chassis(!!terminalEvent.isE5E6Chassis);
        }
        const hasFaults = accumulated.components.length > 0 || (accumulated.genericErrors || []).length > 0;
        // Any source that isn't the "default-ilom-chain (...)" tag means the response came from a
        // short-circuit (a matched targeted check, a forced check, or faults already documented in
        // a Jira ticket's comments) — the ILOM SSH chain was never opened for it.
        const isTargetedSource = !!terminalEvent.source && !terminalEvent.source.startsWith('default-ilom-chain');
        const isCheckMatch = terminalEvent.source?.includes(' -> ');
        const via = isTargetedSource ? ` (via ${isCheckMatch ? terminalEvent.source.split(' -> ')[0] : terminalEvent.source}, ILOM not checked)` : '';
        setDiagnoseStatus(!hasFaults
          ? 'No open problems detected.'
          : `Faults detected${via}: ${accumulated.components.length > 0 ? accumulated.components.join(', ') : 'see error below'}`);

        const parts = getLoggableParts(accumulated);
        if (parts.length > 0) {
          const checkName = isCheckMatch ? terminalEvent.source.split(' -> ')[1] : undefined;
          setLogPanel({ serialNumber: formData.sn, parts, checkName, source: terminalEvent.source });
        }
      }
    } catch (e) {
      setDiagnoseError(e.message || 'Diagnosis failed');
    } finally {
      setDiagnosing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '20px' }}>
      <div style={{ alignSelf: 'stretch', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {/* Manual override for isE5E6Chassis — it's normally set automatically from the diagnose
            stream's terminal event (see the Model-field detection in
            server/src/routes/diagnose.js), but a technician may want to preview/check the other
            chassis layout before running a diagnosis at all, or override a wrong auto-detection. */}
        <div style={{
          display: 'flex', borderRadius: '4px', border: '1px solid #33405a', overflow: 'hidden',
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {[{ key: false, label: 'B300' }, { key: true, label: 'E5-2c/E6-2c' }].map((opt) => (
            <button
              key={String(opt.key)}
              onClick={() => setIsE5E6Chassis(opt.key)}
              style={{
                fontFamily: 'inherit', fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em',
                textTransform: 'uppercase', padding: '6px 12px', cursor: 'pointer', border: 'none',
                background: isE5E6Chassis === opt.key
                  ? 'linear-gradient(180deg, #243d64 0%, #182a48 100%)' : 'transparent',
                color: isE5E6Chassis === opt.key ? '#a8c4e8' : '#6a7a99',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {/* Manual "report any part" mode — while on, clicking a part on the chassis (instead of
              its normal reveal/expand click, see ServerOverview.jsx/E5E6Overview.jsx) opens the
              report-confirm dialog below instead. Disabled until a server is loaded since there's
              no serialNumber yet to attach a report to. */}
          <button
            onClick={() => setReportMode((v) => !v)}
            disabled={!serialNumber}
            style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 700,
              letterSpacing: '0.05em', textTransform: 'uppercase', padding: '6px 12px',
              cursor: serialNumber ? 'pointer' : 'default', borderRadius: '4px',
              border: reportMode ? '1px solid #8a6a2a' : '1px solid #33405a',
              background: reportMode
                ? 'linear-gradient(180deg, #4a3512 0%, #362408 100%)' : 'transparent',
              color: !serialNumber ? '#4a5670' : (reportMode ? '#e8c890' : '#6a7a99'),
            }}
          >
            {reportMode ? 'Reporting — click a part' : 'Report Issue'}
          </button>
          <NavMenu />
        </div>
      </div>
      {/* gap is wider than it looks like it needs to be — the chassis's U-height labels and left
          rack ear are absolutely positioned outside its own 740px layout box (see
          ServerContainer.module.css), so a smaller gap here crowds right into that decoration. */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '70px' }}>
        <div style={{ width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <ServerForm onSubmit={handleFormSubmit} />
          {(diagnosing || flowNotice || diagnoseStatus) && (
            <div style={statusCardStyle}>
              {diagnosing && <p style={{ color: '#8a9ab0', margin: 0 }}>{loadingNotice || 'Running diagnostics…'}</p>}
              {!diagnosing && flowNotice && <p style={{ color: '#8a9ab0', margin: 0 }}>{flowNotice}</p>}
              {!diagnosing && diagnoseStatus && (
                <p style={{ color: diagnoseStatus.startsWith('Faults') ? '#ff8080' : '#7ad67a', margin: 0 }}>{diagnoseStatus}</p>
              )}
            </div>
          )}
        </div>
        {isE5E6Chassis
          ? <E5E6Overview refreshKey={refreshKey} faults={faults} chassisModel={chassisModel} reportMode={reportMode} onPartClick={handlePartClick} />
          : <ServerOverview refreshKey={refreshKey} faults={faults} reportMode={reportMode} onPartClick={handlePartClick} />}
      </div>
      {/* genericErrors, diagnoseError, and LogFailurePanel all get their own full-width row below
          the sidebar (rather than squeezed into the 300px sidebar column, or — for genericErrors —
          rendered inside ServerOverview right above the chassis header) so they can use the full
          740px width instead of being capped at 300px, and so they don't crowd the chassis's
          absolutely-positioned U-height labels/rack ear that extend left of its own 740px layout
          box (see the gap comment above). */}
      {(faults.genericErrors || []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', maxWidth: '740px' }}>
          {faults.genericErrors.map((msg, i) => (
            <div key={i} style={genericErrorStyle}>⚠ {msg}</div>
          ))}
        </div>
      )}
      {diagnoseError && (
        <div style={{ ...statusCardStyle, width: '100%', maxWidth: '740px' }}>
          <p style={{ color: '#ff8080', margin: 0 }}>{diagnoseError}</p>
        </div>
      )}
      {logPanel && (
        <LogFailurePanel
          serialNumber={logPanel.serialNumber}
          parts={logPanel.parts}
          checkName={logPanel.checkName}
          source={logPanel.source}
          onDismiss={() => setLogPanel(null)}
        />
      )}
      {serialNumber && (reportMode || reportCart.length > 0 || pendingReport) && (
        <ReportCart
          serialNumber={serialNumber}
          cart={reportCart}
          onRemove={handleRemoveFromCart}
          pendingPart={pendingReport}
          onConfirmPending={handleConfirmPending}
          onCancelPending={handleCancelPending}
        />
      )}
    </div>
  );
}

export default App;
