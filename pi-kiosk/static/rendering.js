// Roster and attendance values remain text when inserted into kiosk markup.
(function (root) {
    function text(value) {
        return String(value ?? "").replace(/[&<>"']/g, char => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[char]);
    }

    function roster(admin) {
        const rows = (admin.workers || []).slice(0, 30).map(worker => `
            <div class="worker-row">
                <span>${text(worker.name)}</span>
                <span>${text(worker.photo_count)} photos</span>
                <span>ID: ${text(worker.employee_id || worker.id)}</span>
            </div>
        `).join("");
        return `<div style="margin-bottom:8px;color:#f0d18b;">
            Workers: ${text(admin.worker_count || 0)} | Photos: ${text(admin.total_photos || 0)}
        </div>${rows || "<div>No workers enrolled.</div>"}`;
    }

    function attendance(logs) {
        const rows = logs.slice(0, 6).map(item => {
            const timestamp = new Date(item.timestamp);
            const time = isNaN(timestamp.getTime()) ? item.timestamp : timestamp.toLocaleTimeString("en-US", {
                hour: "2-digit", minute: "2-digit"
            });
            const action = ["clock_in", "clock_out"].includes(item.action) ? item.action : "";
            return `<div class="log-item">
                <span class="pill ${action}">${text(action.replace("_", " ") || "clock event")}</span>
                <span>${text(item.worker_name)}</span>
                <span>${text(time)}</span>
            </div>`;
        }).join("");
        return rows || '<div class="log-item"><span>No activity today.</span></div>';
    }

    root.KioskRendering = { roster, attendance };
})(globalThis);
