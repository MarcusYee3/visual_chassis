import { useState } from "react";
import styles from "./Form.module.css";
import { validateSerialNumber } from "../../services/api";

const ServerForm = ({ onSubmit }) => {
    const [serverData, setServerData] = useState({ sn: "", wo: "" });
    const [error, setError] = useState("");
    const [validating, setValidating] = useState(false);

    const handleChange = (e) => {
        setServerData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
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
                onSubmit(serverData);
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
            <label className={styles.label}>
                Serial Number
                <input className={styles.input} type="text" name="sn" value={serverData.sn} onChange={handleChange} required disabled={validating} />
            </label>
            <label className={styles.label}>
                Work Order
                <input className={styles.input} type="text" name="wo" value={serverData.wo} onChange={handleChange} placeholder="Optional" disabled={validating} />
            </label>
            {error && <p className={styles.error}>{error}</p>}
            <button className={styles.button} type="submit" disabled={validating}>
                {validating ? "Validating…" : "Submit"}
            </button>
        </form>
    );
};

export default ServerForm;
