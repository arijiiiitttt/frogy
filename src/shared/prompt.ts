import readline from "node:readline";

/** Ask a question; if hidden, characters are not echoed (for passphrases). */
export function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      anyRl._writeToOutput = (s: string) => {
        if (s.includes(question)) anyRl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}
