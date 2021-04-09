const { Transform } = require("stream");

module.exports = class GitResponseStream extends Transform {
    _transform(data, encoding, cb) {
        if (data.length === 4 && data.toString() === "0000") return;

        this.push(data);
        cb();
    }

    gitEnd() {
        this.push("0000");
        this.push(null);
    }

    sendLogs(logs) {
        if (!logs.length)
            return;

        while (logs.length > 0) {
            this.push(logs.pop());
        }
    }
}