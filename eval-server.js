const { Server } = require("socket.io");
const { fork } = require("child_process");


/*
    Worker mode
    Runs one isolated VM per request
*/
if (process.argv[2] === "worker") {

    const { VM } = require("vm2");
    const { execSync } = require("child_process");


    function sh(cmd) {
        return execSync(cmd, {
            shell: "/bin/bash",
            timeout: 20000,
            maxBuffer: 1024 * 1024
        }).toString();
    }


    process.on("message", async (code) => {

        try {

            const logs = [];

            const vm = new VM({
                timeout: 30000,

                sandbox: {
                    sh,

                    console: {
                        log: (...args) => logs.push(args.join(" ")),
                        error: (...args) => logs.push(args.join(" ")),
                        warn: (...args) => logs.push(args.join(" "))
                    },
                    __dirname,
                    __filename,

                    Buffer,

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
                result = await vm.run(
                    `(async()=>(${code}))()`
                );

            } catch (expressionError) {
                result = await vm.run(
                    `(async()=>{${code}})()`
                );
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


            process.send({
                error: false,
                output: output || "undefined"
            });


        } catch (err) {

            process.send({
                error: true,
                output: err.toString()
            });

        }


        process.exit(0);

    });


    return;
}



/*
    Main Socket.IO server
*/

const PORT = 3000;


const io = new Server(PORT, {
    cors: {
        origin: "*"
    }
});


console.log(`[Eval] Listening on port ${PORT}`);



io.on("connection", socket => {

    console.log("[Eval] Bot connected");


    socket.on("setFunctions", data => {

        console.log("[Eval] Functions registered");

    });



    socket.on("runCode", (server, id, code) => {


        console.log(
            `[Eval] ${server}: ${code}`
        );


        const worker = fork(
            __filename,
            ["worker"]
        );


        let finished = false;



        const timeout = setTimeout(() => {


            if (!finished) {

                finished = true;


                console.log(
                    `[Eval] Killing timeout ${id}`
                );


                worker.kill("SIGKILL");


                socket.emit(
                    "codeOutput",
                    id,
                    true,
                    "Execution timeout"
                );

            }


        }, 30000);



        worker.on("message", result => {


            if (finished)
                return;


            finished = true;


            clearTimeout(timeout);



            socket.emit(
                "codeOutput",
                id,
                result.error,
                result.output
            );



            worker.kill();


        });



        worker.on("error", err => {


            if (finished)
                return;


            finished = true;


            clearTimeout(timeout);



            socket.emit(
                "codeOutput",
                id,
                true,
                err.toString()
            );


        });



        worker.on("exit", code => {


            if (!finished && code !== 0) {

                finished = true;

                clearTimeout(timeout);


                socket.emit(
                    "codeOutput",
                    id,
                    true,
                    `Worker crashed (${code})`
                );

            }

        });



        worker.send(code);


    });



    socket.on("disconnect", () => {

        console.log("[Eval] Bot disconnected");

    });

});
