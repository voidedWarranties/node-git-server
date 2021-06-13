const zlib = require('zlib');
const util = require('util');
const os = require('os');
const { spawn } = require('child_process');
const GitResponseStream = require("./GitResponseStream");
const { PassThrough } = require("stream");

const HttpDuplex = require('./http-duplex');

const headerRE = {
    'receive-pack': '([0-9a-fA-F]{4})([0-9a-fA-F]+) ([0-9a-fA-F]+) (refs\/(heads|tags)\/(.*?))( |00|\u0000)|^(0000)$', // eslint-disable-line
    'upload-pack': '^\\S+ ([0-9a-fA-F]+)'
};

const pktLine = s => {
    const n = (4 + s.length).toString(16);
    return Array(4 - n.length + 1).join('0') + n + s;
};

class Service extends HttpDuplex {
    /**
     * Handles invoking the git-*-pack binaries
     * @class Service
     * @extends HttpDuplex
     * @param  {Object}               opts - options to bootstrap the service object
     * @param  {http.IncomingMessage }   req  - http request object
     * @param  {http.ServerResponse}  res  - http response
     */
    constructor(opts, req, res) {
        super(req, res);

        var self = this;

        this.status = 'pending';
        this.repo = opts.repo;
        this.service = opts.service;
        this.cwd = opts.cwd;

        this.responseStream = new GitResponseStream();
        this.responseStream.pipe(res);

        var buffered = new PassThrough().pause();

        // stream needed to receive data after decoding, but before accepting
        var ts = new PassThrough();

        var decoder = {
            'gzip': () => zlib.createGunzip(),
            'deflate': () => zlib.createDeflate()
        }[req.headers['content-encoding']];

        let reqStream;

        if (decoder) {
            // data is compressed with gzip or deflate
            reqStream = req.pipe(decoder());
        } else {
            // data is not compressed
            reqStream = req;
        }

        if (req.headers["authorization"]) {
            const tokens = req.headers["authorization"].split(" ");
            if (tokens[0] === "Basic") {
                const splitHash = Buffer.from(tokens[1], 'base64').toString('utf8').split(":");
                this.username = splitHash.shift();
            }
        }

        this.bufs = [];
        this.data = null;

        const handleData = buf => {
            this.bufs.push(buf);

            let length = 0;

            for (const b of this.bufs) {
                length += b.length;
            }

            if (parseInt(req.headers["content-length"]) == length) {
                reqStream.off("data", handleData);
                this.data = Buffer.concat(this.bufs);
                this.emit("buffer", this.data);

                ts.write(this.data);
                buffered.write(this.data);
            }
        };

        reqStream.on("data", handleData);

        ts.once('data', function onData(buf) {
            var ops = buf.toString().match(new RegExp(headerRE[self.service], 'gi'));
            if (!ops) return;

            ops.forEach(function (op) {
                var type;
                var m = op.match(new RegExp(headerRE[self.service]));

                if (self.service === 'receive-pack') {
                    self.last = m[2];
                    self.commit = m[3];
                    self.ref = m[4];

                    if (m[5] == 'heads') {
                        type = 'branch';
                        self.evName = 'push';
                    } else {
                        type = 'version';
                        self.evName = 'tag';
                    }

                    var headers = {
                        last: self.last,
                        commit: self.commit
                    };
                    headers[type] = self[type] = m[6];
                    self.emit('header', headers);
                } else if (self.service === 'upload-pack') {
                    self.commit = m[1];
                    self.evName = 'fetch';
                    self.emit('header', {
                        commit: self.commit
                    });
                }
            });
        });

        self.once('accept', function onAccept() {
            process.nextTick(function () {
                const cmd = os.platform() == 'win32' ?
                    ['git', opts.service, '--stateless-rpc', opts.cwd]
                    :
                    ['git-' + opts.service, '--stateless-rpc', opts.cwd];

                const ps = spawn(cmd[0], cmd.slice(1));

                ps.on('error', function (err) {
                    self.emit('error', new Error(`${err.message} running command ${cmd.join(' ')}`));
                });

                self.emit('service', ps);

                ps.stdout.pipe(self.responseStream);

                buffered.pipe(ps.stdin);
                buffered.resume();

                ps.on('exit', () => {
                    self.responseStream.gitEnd();

                    self.emit('exit');
                });
            });
        });

        self.once('reject', function onReject(msg) {
            // https://git-scm.com/docs/pack-protocol
            const reportStatus =
                pktLine(`unpack ${msg}\n`) +
                pktLine(`ng ${self.ref} ${msg}\n`) +
                "0000";

            const SIDEBAND = String.fromCharCode(1);

            const rejectMsg = pktLine(SIDEBAND + reportStatus) + "0000";

            self.responseStream.write(Buffer.from(rejectMsg));

            self.responseStream.gitEnd();
        });
    }

    log() {
        const _log = util.format(...arguments);
        const SIDEBAND = String.fromCharCode(2); // PROGRESS
        const message = `${SIDEBAND}${_log}\n`;
        const formattedMessage = Buffer.from(pktLine(message));

        if (!this.responseStream.ended) {
            this.responseStream.write(formattedMessage);
        }
    }
    /**
     * reject request in flight
     * @method reject
     * @memberof Service
     * @param  {String} msg  - message that should be displayed on teh client
     */
    reject(msg) {
        if (this.status !== 'pending') return;

        this.status = 'rejected';
        this.emit('reject', msg);
    }
    /**
     * accepts request to access resource
     * @method accept
     * @memberof Service
     */
    accept() {
        if (this.status !== 'pending') return;

        this.status = 'accepted';
        this.emit('accept');
    }
}

module.exports = Service;
