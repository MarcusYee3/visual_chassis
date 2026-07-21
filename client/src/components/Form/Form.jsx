import { useState } from "react";
import styles from "./Form.module.css";
import { validateSerialNumber } from "../../services/api";

const ServerForm = ({ onSubmit }) => {
    const [serverData, setServerData] = useState({ sn: "", wo: "", jiraLink: "" });
    const [error, setError] = useState("");
    const [validating, setValidating] = useState(false);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setServerData((prev) => ({ ...prev, [name]: (name === "sn" || name === "jiraLink") ? value.trim() : value }));
        setError("");
    };

    const handleEvent = async (event) => {
        event.preventDefault();
        const isConfirm = window.confirm(`Please confirm server detail: \n\nSN: ${serverData.sn}\nWO: ${serverData.wo}`);
        if (!isConfirm) return;

        setValidating(true);
        setError("");
        try {
            const result = await validateSerialNumber(serverData.sn);
            if (result.valid) {
                onSubmit({ ...serverData, ilomIp: result.ilomIp });
            } else {
                setError("SN is invalid.");
            }
        } catch (e) {
            setError(e.message || "Could not reach server.");
        } finally {
            setValidating(false);
        }
    };

    return (
        <form className={styles.form} onSubmit={handleEvent}>
            <div className={styles.header}>
                <span className={styles.headerDot} />
                <span className={styles.headerTitle}>Server Lookup</span>
            </div>

            <div className={styles.grid}>
                <label className={`${styles.label} ${styles.colSn}`}>
                    Serial Number
                    <input className={styles.input} type="text" name="sn" value={serverData.sn} onChange={handleChange} required disabled={validating} />
                </label>
                <label className={`${styles.label} ${styles.colWo}`}>
                    Work Order
                    <input className={styles.input} type="text" name="wo" value={serverData.wo} onChange={handleChange} placeholder="Optional" disabled={validating} />
                </label>
                <label className={`${styles.label} ${styles.colJira}`}>
                    Jira API Link
                    <input
                        className={styles.input}
                        type="text"
                        name="jiraLink"
                        value={serverData.jiraLink}
                        onChange={handleChange}
                        placeholder="https://jira.synnex.com/rest/api/2/issue/MFG-XXXXXX"
                        disabled={validating}
                    />
                </label>
            </div>

            <div className={styles.footer}>
                {error && <p className={styles.error}>{error}</p>}
                <button className={styles.button} type="submit" disabled={validating}>
                    {validating ? "Validating…" : "Submit"}
                </button>
            </div>
        </form>
    );
};

export default ServerForm;
