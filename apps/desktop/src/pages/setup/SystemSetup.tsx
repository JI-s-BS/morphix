// Settings → System setup: everything the first-run wizard set, changeable later. Admin only;
// a signed-in user can change their own password; anyone else is asked to sign in.
import { useEffect, useState } from "react";
import { call, type Status } from "./api";
import { AccountsPanel, ChangePasswordForm, FeaturesPanel, KeysPanel, LoginForm, Msg, PrinterList, SlicerPicker } from "./parts";
import { useSetupSession } from "./session";

export function SystemSetup() {
  const session = useSetupSession();
  const [status, setStatus] = useState<Status | null>(null);
  const [rev, setRev] = useState(0);
  const admin = session.user?.role === "admin";

  useEffect(() => {
    if (admin) void call<Status>("GET", "/api/setup/status").then(setStatus, () => setStatus(null));
  }, [admin, rev]);

  if (!session.available) {
    return (
      <div className="su-system">
        <div className="su-card">
          <h3>System setup</h3>
          <p className="su-lead">System setup runs on the Morphix server. Open <b>http://&lt;this machine&gt;:8080</b> in a browser to change printers, slicer, keys and accounts.</p>
        </div>
      </div>
    );
  }
  if (!session.user) {
    return (
      <div className="su-system">
        <LoginForm note="Sign in as an admin to change printers, the slicer, API keys and accounts." onDone={() => void session.refresh()} />
      </div>
    );
  }
  const signOut = (
    <div className="su-card">
      <div className="su-row" style={{ padding: 0 }}>
        <div className="grow">Signed in as <b>{session.user.name}</b> ({session.user.role})</div>
        <button className="btn" onClick={() => void session.logout()}>Sign out</button>
      </div>
    </div>
  );
  if (!admin) {
    return (
      <div className="su-system">
        {signOut}
        <Msg kind="warn" text="Only an admin can change system settings." />
        <ChangePasswordForm onDone={() => void session.refresh()} />
      </div>
    );
  }
  return (
    <div className="su-system">
      {signOut}
      {status?.issues?.map((i) => <Msg key={i} kind="warn" text={i} />)}
      <PrinterList onChange={() => setRev((r) => r + 1)} />
      <SlicerPicker />
      <KeysPanel onChange={() => setRev((r) => r + 1)} />
      {status?.features && <FeaturesPanel key={rev} initial={status.features} />}
      <AccountsPanel me={session.user} />
      <ChangePasswordForm onDone={() => void session.refresh()} />
    </div>
  );
}
