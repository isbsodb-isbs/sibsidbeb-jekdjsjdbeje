const { Server } = require("socket.io");
const { spawn, execSync } = require("child_process");
const crypto = require("crypto");

/*
    Worker mode
    Runs one isolated VM per request, inside a disposable Docker container.
    Invoked as: node eval-server.js worker <base64-code>
*/
if (process.argv[2] === "worker") {
    const { VM } = require("vm2");

    function sh(cmd) {
        return execSync(cmd, {
            shell: "/bin/bash",
            timeout: 60000,
            maxBuffer: 60 * 1024 * 1024
        }).toString();
    }

    const emit = (payload) => {
        process.stdout.write(JSON.stringify(payload) + "\n");
    };

    (async () => {
        const code = Buffer.from(
            String(process.argv[3] || ""),
            "base64"
        ).toString("utf8");

        try {
            const logs = [];

            const vm = new VM({
                timeout: 60000,
                sandbox: {
                    sh,
                    console: {
                        log: (...args) => { logs.push(args.join(" ")); },
                        error: (...args) => { logs.push(args.join(" ")); },
                        warn: (...args) => { logs.push(args.join(" ")); }
                    },
                    Buffer,
                    process,
                    require,
                    module,
                    exports,
                    global,
                    globalThis,
                    fetch,
                    FormData,
                    Headers,
                    Request,
                    Response,
                    AbortController,
                    setTimeout,
                    setInterval,
                    clearTimeout,
                    clearInterval,
                    queueMicrotask,
                    URL,
                    URLSearchParams,
                    TextEncoder,
                    TextDecoder,
                    JSON,
                    Math,
                    Date,
                    RegExp,
                    Map,
                    Set,
                    WeakMap,
                    WeakSet,
                    WeakRef,
                    FinalizationRegistry,
                    Promise,
                    Array,
                    Object,
                    String,
                    Number,
                    Boolean,
                    Symbol,
                    BigInt,
                    Proxy,
                    Reflect,
                    Intl,
                    Error,
                    TypeError,
                    RangeError,
                    ReferenceError,
                    SyntaxError,
                    EvalError,
                    URIError
                }
            });

            let result;
            try {
                result = await vm.run(`(async()=>(${code}))()`);
            } catch (expressionError) {
                result = await vm.run(`(async()=>{${code}})()`);
            }

            let output = "";

            if (logs.length > 0) {
                output += logs.join("\n");
            }

            if (result !== undefined) {
                if (output.length > 0)
                    output += "\n";
                output += String(result);
            }

            emit({ error: false, output: output || "undefined" });
        } catch (err) {
            emit({ error: true, output: err.toString() });
        }

        process.exit(0);
    })();

    return;
}

/*
    Main Socket.IO server
*/


const PORT = 3000;
const IMAGE = process.env.EVAL_WORKER_IMAGE || "eval-worker";

try {
    console.log("[Eval] Building worker image...");

    execSync(
        "docker build -f Dockerfile.worker -t eval-worker .",
        {
            stdio: "inherit",
            timeout: 120000
        }
    );

    console.log("[Eval] Worker image ready");

} catch (err) {
    console.error("[Eval] Worker image build failed");
    console.error(err.toString());
    process.exit(1);
}


const io = new Server(PORT, {
    cors: { origin: "*" }
});

console.log(`[Eval] Listening on port ${PORT}`);

io.on("connection", socket => {
    console.log("[Eval] Bot connected");

    socket.on("setFunctions", data => {
        console.log("[Eval] Functions registered");
    });

    socket.on("runCode", (server, id, code) => {
        console.log(`[Eval] ${server}: ${code}`);

        const containerName = `eval-${crypto.randomBytes(8).toString("hex")}`;
        const encoded = Buffer.from(String(code), "utf8").toString("base64");

        // One request = one disposable container. No env vars forwarded into it.
        const worker = spawn(
            "docker",
            [
                "run",
                "--rm",
                "--name", containerName,
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true",
                "--read-only",
                "--memory=512m",
                "--cpus=1",
                "--pids-limit=50",
                "--tmpfs", "/tmp:size=64m,noexec,nosuid",
                IMAGE,
                "node", "eval-server.js", "worker", encoded
            ],
            {
                env: { PATH: process.env.PATH },
                stdio: ["ignore", "pipe", "pipe"]
            }
        );

        let stdout = "";
        let stderr = "";
        let finished = false;

        const timeout = setTimeout(() => {
            if (!finished) {
                finished = true;
                console.log(`[Eval] Killing timeout ${id}`);
                spawn("docker", ["kill", containerName], {
                    env: { PATH: process.env.PATH },
                    stdio: "ignore"
                });
                worker.kill("SIGKILL");
                socket.emit("codeOutput", id, true, "Execution timeout");
            }
        }, 30000);

        worker.stdout.on("data", d => (stdout += d.toString()));
        worker.stderr.on("data", d => (stderr += d.toString()));

        worker.on("error", err => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            socket.emit("codeOutput", id, true, err.toString());
        });

        worker.on("close", code => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);

            const line = stdout
                .split("\n")
                .map(l => l.trim())
                .filter(Boolean)
                .pop();

            let result = null;
            if (line) {
                try { result = JSON.parse(line); } catch (err) { result = null; }
            }

            if (result) {
                socket.emit(
                    "codeOutput",
                    id,
                    Boolean(result.error),
                    String(result.output)
                );
                return;
            }

            socket.emit(
                "codeOutput",
                id,
                true,
                stderr.trim() || `Worker crashed (${code})`
            );
        });
    });

    socket.on("disconnect", () => {
        console.log("[Eval] Bot disconnected");
    });
});
