interface MetroResolverContext {
  readonly originModulePath: string;
  resolveRequest(
    context: MetroResolverContext,
    moduleName: string,
    platform: string | null,
  ): unknown;
}

interface MetroConfigLike {
  resolver?: {
    resolveRequest?: (
      context: MetroResolverContext,
      moduleName: string,
      platform: string | null,
    ) => unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type MetroResolveRequest = (
  context: MetroResolverContext,
  moduleName: string,
  platform: string | null,
) => unknown;

export declare function withSimplySyncMetroConfig<T extends MetroConfigLike>(
  config: T,
): T & {
  resolver: NonNullable<T["resolver"]> & {
    resolveRequest: MetroResolveRequest;
  };
};
