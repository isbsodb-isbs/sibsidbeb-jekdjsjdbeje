const { Server } = require("socket.io");
const { execSync } = require("child_process");

const PORT = 3000;

const io = new Server(PORT, {
    cors: {
        origin: "*"
    }
});

console.log(`[Eval] Listening on port ${PORT}`);

global.sh = (command) => {
    try {
        return execSync(command, {
            shell: "/bin/bash",
            timeout: 60000,
            maxBuffer: 1024 * 1024
        }).toString();
    } catch (e) {
        return e.toString();
    }
};

io.on("connection", (socket) => {

    console.log("[Eval] Bot connected");

    socket.on("setFunctions", (data) => {
        console.log("[Eval] Functions registered");
    });


    socket.on("runCode", (server, id, code) => {

        console.log(`[Eval] ${server}: ${code}`);

        let output;
        let error = false;

        try {
            output = eval(code);

            if (output === undefined) {
                output = "undefined";
            } else {
                output = String(output);
            }

        } catch (e) {
            error = true;
            output = e.toString();
        }

        socket.emit(
            "codeOutput",
            id,
            error,
            output
        );
    });


    socket.on("disconnect", () => {
        console.log("[Eval] Bot disconnected");
    });

});
