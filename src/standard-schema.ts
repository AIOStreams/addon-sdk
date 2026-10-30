/** The Standard Schema interface (standardschema.dev), which zod, Valibot and ArkType implement. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) =>
      | StandardSchemaV1.Result<Output>
      | Promise<StandardSchemaV1.Result<Output>>;
    readonly types?:
      { readonly input: Input; readonly output: Output } | undefined;
    /** Standard JSON Schema, which builds the configuration form. */
    readonly jsonSchema?: {
      readonly input: (options: { target: string }) => Record<string, unknown>;
    };
  };
}

export declare namespace StandardSchemaV1 {
  type Result<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: ReadonlyArray<Issue> };

  interface Issue {
    readonly message: string;
    readonly path?:
      ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  }

  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

export function formatIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>
): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) =>
          String(typeof segment === 'object' ? segment.key : segment)
        )
        .join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
