/** Thrown by a tool that must wait (approval, human answer, sub-agents, vault unlock). The task is re-queued and resumed later. */
export class Wait extends Error {
  constructor(
    public seconds: number,
    public note: string,
  ) {
    super(note);
  }
}
