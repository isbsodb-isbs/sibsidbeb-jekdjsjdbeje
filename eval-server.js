const { Server } = require("socket.io");
const { fork } = require("child_process");
const { execSync } = require("child_process");


/*
    Worker mode
    This part runs only inside isolated command processes
*/
if (process.argv[2] === "worker") {

    global.sh = (cmd) => {
        return execSync(cmd, {
            shell: "/bin/bash",
            timeout: 20000,
            maxBuffer: 1024 * 1024
        }).toString();
    };


    process.on("message", async (code) => {

        try {

            const result = await eval(
                `(async()=>(${code}))()`
            );

            process.send({
                error: false,
                output:
                    result === undefined
                    ? "undefined"
                    : String(result)
            });


        } catch (e) {

            process.send({
                error: true,
                output: e.toString()
            });

        }

        process.exit(0);

    });

    return;
}



/*
    Server mode
*/

const PORT = 3000;

const io = new Server(PORT, {
    cors: {
        origin: "*"
    }
});


console.log(`[Eval] Listening on ${PORT}`);


io.on("connection", socket => {

    console.log("[Eval] Bot connected");


    socket.on("setFunctions", () => {
        console.log("[Eval] Functions registered");
    });


    socket.on("runCode", (server, id, code) => {

        console.log(`[Eval] ${server}: ${code}`);


        const worker = fork(
            __filename,
            ["worker"]
        );


        let finished = false;


        const timeout = setTimeout(() => {

            if (!finished) {

                finished = true;

                worker.kill("SIGKILL");

                socket.emit(
                    "codeOutput",
                    id,
                    true,
                    "Execution timeout"
                );

            }

        }, 30000);


        worker.on("message", msg => {

            if (finished)
                return;


            finished = true;

            clearTimeout(timeout);


            socket.emit(
                "codeOutput",
                id,
                msg.error,
                msg.output
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


        worker.send(code);

    });


    socket.on("disconnect", () => {
        console.log("[Eval] Bot disconnected");
    });

});
