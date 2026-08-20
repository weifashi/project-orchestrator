export type ConfirmationRequest = Readonly<{
  confirmation_request_id: string;
  nonce: string;
  exact_action_hash: string;
  exact_action: string;
  target: string;
  expires_at: string;
}>;
export type ConfirmationDecision = 'approve' | 'reject';
export type TrustedConfirmationInput = Readonly<{
  prompt: (display: Pick<ConfirmationRequest, 'exact_action' | 'target' | 'expires_at'>) => Promise<ConfirmationDecision>;
  submit: (request: {
    kind: 'submit_confirmation';
    payload: Pick<ConfirmationRequest, 'confirmation_request_id' | 'nonce' | 'exact_action_hash' | 'expires_at'> & {
      decision: ConfirmationDecision;
    };
  }) => Promise<unknown>;
}>;

export class InteractiveConfirmationChannel {
  readonly #input: TrustedConfirmationInput | undefined;

  constructor(input?: TrustedConfirmationInput) {
    this.#input = input;
  }

  get available(): boolean {
    return this.#input !== undefined;
  }

  async confirm(request: ConfirmationRequest): Promise<unknown> {
    if (this.#input === undefined) throw new Error('HOST_CONFIRMATION_UNAVAILABLE');
    const decision = await this.#input.prompt({
      exact_action: request.exact_action,
      target: request.target,
      expires_at: request.expires_at,
    });
    return this.#input.submit({
      kind: 'submit_confirmation',
      payload: {
        confirmation_request_id: request.confirmation_request_id,
        nonce: request.nonce,
        exact_action_hash: request.exact_action_hash,
        expires_at: request.expires_at,
        decision,
      },
    });
  }
}
