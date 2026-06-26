import { useState } from "react";
import styles from "./Form.module.css";
import { getRecordsBySerial } from "../../services/api";

const ServerForm = ({ onSubmit }) => {
    const [serverData, setServerData] = useState({
        sn : "",
        wo : ""
    });
    const [error, setError] = useState("");

    const handleChange = (e) => {
        setServerData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
        setError("");
    };

    const handleEvent = async (event) => {
        event.preventDefault();
        const isConfirm = window.confirm(`Please confirm server detail: \n\nSN: ${serverData.sn}\nWO: ${serverData.wo}`);

        if (isConfirm) {
            const result = await getRecordsBySerial(serverData.sn);
            const isValidSn = result.total > 0;

            if (isValidSn) {
                onSubmit(serverData, result.records);
            } else {
                setError("No records found for this serial number.");
            }
        }
    };

    return (
        <form className={styles.form} onSubmit={handleEvent}>
            <label className={styles.label}>
                Serial Number
                <input className={styles.input} type="text" name="sn" value={serverData.sn} onChange={handleChange} required />
            </label>
            <label className={styles.label}>
                Work Order
                <input className={styles.input} type="text" name="wo" value={serverData.wo} onChange={handleChange} placeholder="Optional" />
            </label>
            {error && <p className={styles.error}>{error}</p>}
            <button className={styles.button} type="submit">Submit</button>
        </form>
    );
};

export default ServerForm;
