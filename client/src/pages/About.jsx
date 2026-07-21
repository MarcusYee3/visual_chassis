import { Link } from 'react-router-dom';

const fontStyle = { fontFamily: "'JetBrains Mono', monospace" };
const accent = '#a8c4e8';
const heading = '#8fa8d6';
const body = '#a9b4c9';

function About() {
  return (
    <div style={{ ...fontStyle, padding: '20px', maxWidth: '740px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ color: '#cdd6e8', fontSize: '16px', letterSpacing: '0.04em', margin: 0 }}>ABOUT</h2>
        <Link to="/" style={{ color: accent, fontSize: '11px', textDecoration: 'none' }}>← Back to Diagnostics</Link>
      </div>

      <div style={{ color: '#cdd6e8', fontSize: '12px', lineHeight: 1.7, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <p style={{ margin: 0 }}>
          <strong style={{ color: accent }}>Server Component Visualizer</strong> renders an interactive
          chassis diagram (GBB tray, GPU baseboard, IOB tray, PSU) for a given server serial number and
          runs automated diagnostics against it.
        </p>

        <div>
          <div style={{ color: heading, fontWeight: 700, marginBottom: '6px' }}>Diagnostic sources, checked in priority order</div>
          <ol style={{ margin: 0, paddingLeft: '18px', color: body }}>
            <li>A linked Jira repair ticket, if one is supplied — its summary, description, and comments are scanned for a known failing check or a fault already documented by a technician.</li>
            <li>The mfg-collector live JBOG test table, for units currently in manufacturing test.</li>
            <li>A live ILOM session — <code>Open_Problems</code>, <code>fmadm faulty</code>, and the <code>hwdiag</code> io config / fan / temp / fabric-test chain.</li>
          </ol>
        </div>

        <div>
          <div style={{ color: heading, fontWeight: 700, marginBottom: '6px' }}>Other features</div>
          <ul style={{ margin: 0, paddingLeft: '18px', color: body }}>
            <li>Per-part failure logging, with a searchable history at <Link to="/failures" style={{ color: accent }}>Failure Log</Link>.</li>
            <li>Duplicate-log detection — confirms before re-logging a part already on file.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default About;
