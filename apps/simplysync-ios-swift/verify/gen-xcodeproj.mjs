// Generates SimplySyncDemo.xcodeproj/project.pbxproj with explicit file
// references for every .swift under SimplySyncDemo/. Deterministic IDs.
import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname; // apps/simplysync-ios-swift/
const appDir = join(root, "SimplySyncDemo");

let counter = 0;
const id = () => {
  counter += 1;
  return "AABB" + counter.toString(16).toUpperCase().padStart(20, "0");
};

function swiftFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full));
    else if (entry.endsWith(".swift")) out.push(full);
  }
  return out;
}

const files = swiftFiles(appDir).sort();
const refs = files.map((path) => ({
  path,
  rel: relative(appDir, path),
  fileRef: id(),
  buildFile: id(),
}));

const PROJECT = id();
const TARGET = id();
const PRODUCT = id();
const MAIN_GROUP = id();
const APP_GROUP = id();
const KIT_GROUP = id();
const ENGINE_GROUP = id();
const PRODUCTS_GROUP = id();
const SOURCES_PHASE = id();
const FRAMEWORKS_PHASE = id();
const RESOURCES_PHASE = id();
const PROJ_CONFIG_LIST = id();
const TARGET_CONFIG_LIST = id();
const PROJ_DEBUG = id();
const PROJ_RELEASE = id();
const TARGET_DEBUG = id();
const TARGET_RELEASE = id();

const rootRefs = refs.filter((r) => !r.rel.includes("/"));
const kitRefs = refs.filter((r) => r.rel.startsWith("Kit/"));
const engineRefs = refs.filter((r) => r.rel.startsWith("Engine/"));

const pbxBuildFiles = refs
  .map(
    (r) =>
      `\t\t${r.buildFile} /* ${r.rel} in Sources */ = {isa = PBXBuildFile; fileRef = ${r.fileRef} /* ${r.rel} */; };`,
  )
  .join("\n");

const pbxFileRefs = refs
  .map((r) => {
    const name = r.rel.split("/").pop();
    return `\t\t${r.fileRef} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };`;
  })
  .join("\n");

const productRef = `\t\t${PRODUCT} /* SimplySyncDemo.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = SimplySyncDemo.app; sourceTree = BUILT_PRODUCTS_DIR; };`;

const sourcesList = refs
  .map((r) => `\t\t\t\t${r.buildFile} /* ${r.rel} in Sources */,`)
  .join("\n");

const appGroupChildren = [
  ...rootRefs.map((r) => `\t\t\t\t${r.fileRef} /* ${r.rel} */,`),
  `\t\t\t\t${ENGINE_GROUP} /* Engine */,`,
  `\t\t\t\t${KIT_GROUP} /* Kit */,`,
].join("\n");

const kitGroupChildren = kitRefs
  .map((r) => `\t\t\t\t${r.fileRef} /* ${r.rel.split("/").pop()} */,`)
  .join("\n");

const engineGroupChildren = engineRefs
  .map((r) => `\t\t\t\t${r.fileRef} /* ${r.rel.split("/").pop()} */,`)
  .join("\n");

const pbx = `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 56;
\tobjects = {

/* Begin PBXBuildFile section */
${pbxBuildFiles}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
${pbxFileRefs}
${productRef}
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${FRAMEWORKS_PHASE} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${MAIN_GROUP} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${APP_GROUP} /* SimplySyncDemo */,
\t\t\t\t${PRODUCTS_GROUP} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${APP_GROUP} /* SimplySyncDemo */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${appGroupChildren}
\t\t\t);
\t\t\tpath = SimplySyncDemo;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${KIT_GROUP} /* Kit */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${kitGroupChildren}
\t\t\t);
\t\t\tpath = Kit;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${ENGINE_GROUP} /* Engine */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${engineGroupChildren}
\t\t\t);
\t\t\tpath = Engine;
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${PRODUCTS_GROUP} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${PRODUCT} /* SimplySyncDemo.app */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${TARGET} /* SimplySyncDemo */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${TARGET_CONFIG_LIST} /* Build configuration list for PBXNativeTarget "SimplySyncDemo" */;
\t\t\tbuildPhases = (
\t\t\t\t${SOURCES_PHASE} /* Sources */,
\t\t\t\t${FRAMEWORKS_PHASE} /* Frameworks */,
\t\t\t\t${RESOURCES_PHASE} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = SimplySyncDemo;
\t\t\tproductName = SimplySyncDemo;
\t\t\tproductReference = ${PRODUCT} /* SimplySyncDemo.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${PROJECT} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 1600;
\t\t\t\tLastUpgradeCheck = 1600;
\t\t\t\tTargetAttributes = {
\t\t\t\t\t${TARGET} = {
\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;
\t\t\t\t\t};
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = ${PROJ_CONFIG_LIST} /* Build configuration list for PBXProject */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${MAIN_GROUP};
\t\t\tproductRefGroup = ${PRODUCTS_GROUP} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${TARGET} /* SimplySyncDemo */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${RESOURCES_PHASE} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${SOURCES_PHASE} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${sourcesList}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
\t\t${PROJ_DEBUG} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;
\t\t\t\tCOPY_PHASE_STRIP = NO;
\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;
\t\t\t\tENABLE_TESTABILITY = YES;
\t\t\t\tGCC_OPTIMIZATION_LEVEL = 0;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;
\t\t\t\tONLY_ACTIVE_ARCH = YES;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${PROJ_RELEASE} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;
\t\t\t\tCOPY_PHASE_STRIP = NO;
\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
\t\t\t\tENABLE_NS_ASSERTIONS = NO;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-O";
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\t${TARGET_DEBUG} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_GENERATE_ASSET_SYMBOLS = NO;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tENABLE_PREVIEWS = YES;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = "SimplySyncDemo/Info.plist";
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = dev.simplysync.engineios;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${TARGET_RELEASE} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_GENERATE_ASSET_SYMBOLS = NO;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tENABLE_PREVIEWS = YES;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = "SimplySyncDemo/Info.plist";
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = dev.simplysync.engineios;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${PROJ_CONFIG_LIST} /* Build configuration list for PBXProject */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${PROJ_DEBUG} /* Debug */,
\t\t\t\t${PROJ_RELEASE} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${TARGET_CONFIG_LIST} /* Build configuration list for PBXNativeTarget "SimplySyncDemo" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${TARGET_DEBUG} /* Debug */,
\t\t\t\t${TARGET_RELEASE} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */
\t};
\trootObject = ${PROJECT} /* Project object */;
}
`;

const projDir = join(root, "SimplySyncDemo.xcodeproj");
mkdirSync(projDir, { recursive: true });
writeFileSync(join(projDir, "project.pbxproj"), pbx);
console.log(`wrote project.pbxproj with ${refs.length} swift files`);
