const { Transform } = require("stream");

module.exports = class GitResponseStream extends Transform {
    constructor() {
        super();

        this.ended = false;
    }

    _transform(data, encoding, cb) {
        if (data.length === 4 && data.toString() === "0000") return;

        this.push(data);

        cb();
    }

    gitEnd() {
        this.ended = true;

        this.push("0000");
        this.push(null);
    }
}