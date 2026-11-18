/**
 * What an image reference may look like.
 *
 * The tag rule is Docker's own: the tag is alphanumerics, underscores, periods and dashes, must
 * start with a letter or a digit, and stops at 128 characters. The dialog says "no" while somebody
 * types, because a tag the engine will refuse is better discovered before the pull than after it.
 *
 * The repository name is left to the engine — registries, ports and digests make a full grammar
 * this build has no business re-stating — and only "is there a name at all" is asked here.
 */
/** Docker's tag grammar, as one pattern. */
export const IMAGE_TAG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Whether a tag is one the engine would accept. The empty string is "the default tag", and is. */
export function isValidImageTag(tag: string): boolean {
  return tag === "" || IMAGE_TAG_PATTERN.test(tag);
}

/** Whether a pull has a repository to pull at all. */
export function isValidImageName(name: string): boolean {
  return name.trim() !== "";
}

/** The reference a pull travels as: the repository, a colon, and the tag when one was typed. */
export function imageReference(name: string, tag: string): string {
  const repository = name.trim();
  const version = tag.trim();
  return version === "" ? repository : `${repository}:${version}`;
}
