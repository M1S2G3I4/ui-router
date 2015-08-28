/// <reference path='../../typings/angularjs/angular.d.ts' />
import {IPromise} from "angular";
import {isInjectable, isString, defaults, extend, curry, addPairToObj, prop, pick, removeFrom, isEq, val, TypedMap} from "../common/common";
import {IStateViewConfig, IViewDeclaration} from "../state/interface";
import {IUiViewData, IContextRef} from "./interface";

let _debug = false;
function debug(...any);
function debug() {
  if (_debug) { console.log.apply(console, arguments); }
}

const viewConfigString = (viewConfig: ViewConfig) =>
    `(ViewConfig targeting ui-view: '${viewConfig.uiViewName}@${viewConfig.uiViewContextAnchor}', context: '${viewConfig.context.name}')`;

/**
 * Given a raw view name from a views: config, returns a normalized target viewName and contextAnchor
 */
function normalizeUiViewTarget(rawViewName = "") {
  // TODO: Validate incoming view name with a regexp to allow:
  // ex: "view.name@foo.bar" , "^.^.view.name" , "view.name@^.^" , "" ,
  // "@" , "$default@^" , "!$default.$default" , "!foo.bar"
  let viewAtContext: string[] = rawViewName.split("@");
  let uiViewName = viewAtContext[0] || "$default";  // default to unnamed view
  let uiViewContextAnchor = isString(viewAtContext[1]) ? viewAtContext[1] : "^";    // default to parent context

  // Handle relative view-name sugar syntax.
  // Matches rawViewName "^.^.^.foo.bar" into array: ["^.^.^.foo.bar", "^.^.^", "foo.bar"],
  let relativeViewNameSugar = /^(\^(?:\.\^)*)\.(.*$)/.exec(uiViewName);
  if (relativeViewNameSugar) {
    // Clobbers existing contextAnchor (rawViewName validation will fix this)
    uiViewContextAnchor = relativeViewNameSugar[1]; // set anchor to "^.^.^"
    uiViewName = relativeViewNameSugar[2]; // set view-name to "foo.bar"
  }

  if (uiViewName.charAt(0) === '!') {
    uiViewName = uiViewName.substr(1);
    uiViewContextAnchor = ""; // target absolutely from root
  }

  return {uiViewName, uiViewContextAnchor};
}

/**
 * Represents the union of a template and (optional) controller.
 *
 * @param {Object} config The view's configuration
 *
 * @returns {Object} New `ViewConfig` object
 */
export class ViewConfig {
  viewDeclarationObj: IViewDeclaration;
  promises: {
    template: IPromise<string>,
    controller: IPromise<Function>
  };

  template: string;
  controller: Function;
  controllerAs: string;

  context: IContextRef;

  uiViewName: string;
  uiViewContextAnchor: string;

  params: any;
  locals: any;

  constructor(stateViewConfig: IStateViewConfig) {
    // viewName is something like "$default" or "foo.bar" or "$default.foo.bar.$default"
    // contextAnchor is something like "fully.qualified.context" or "^" (parent) or  "^.^.^" (parent.parent.parent)
    let {uiViewName, uiViewContextAnchor} = normalizeUiViewTarget(stateViewConfig.rawViewName);

    // handle parent relative targeting "^.^.^"
    let relativeMatch = /^(\^(?:\.\^)*)$/;
    if (relativeMatch.exec(uiViewContextAnchor)) {
      let anchor = uiViewContextAnchor.split(".").reduce(((anchor, x) => anchor.parent), stateViewConfig.context);
      uiViewContextAnchor = anchor.name;
    }

    extend(this, pick(stateViewConfig, "viewDeclarationObj", "params", "context", "locals"), {uiViewName, uiViewContextAnchor});
    this.controllerAs = stateViewConfig.viewDeclarationObj.controllerAs;
  }

  /**
   * Checks a view configuration to ensure that it specifies a template.
   *
   * @return {boolean} Returns `true` if the configuration contains a valid template, otherwise `false`.
   */
  hasTemplate() {
    let viewDef = this.viewDeclarationObj;
    return !!(viewDef.template || viewDef.templateUrl || viewDef.templateProvider);
  }

  getTemplate($factory) {
    let locals = this.locals, viewDef = this.viewDeclarationObj;
    return $factory.fromConfig(viewDef, this.params, locals.invoke.bind(locals));
  }

  /**
   * Gets the controller for a view configuration.
   *
   *
   * @returns {Function|Promise.<Function>} Returns a controller, or a promise that resolves to a controller.
   */
  getController() {
    //* @param {Object} locals A context object from transition.context() to invoke a function in the correct context
    let provider = this.viewDeclarationObj.controllerProvider;
    return isInjectable(provider) ? this.locals.invoke(provider) : this.viewDeclarationObj.controller;
  }
}

/**
 * @ngdoc object
 * @name ui.router.state.$view
 *
 * @requires ui.router.util.$templateFactory
 * @requires $rootScope
 *
 * @description
 *
 */
$View.$inject = ['$rootScope', '$templateFactory', '$q', '$timeout'];
function $View(   $rootScope,   $templateFactory,   $q,   $timeout) {

  let uiViews: IUiViewData[] = [];
  let viewConfigs: ViewConfig[] = [];

  const match = (obj1, ...keys) =>
      (obj2) => keys.reduce(((memo, key) => memo && obj1[key] === obj2[key]), true);

  this.rootContext = function(context) {
    return context ? this._rootContext = context : this._rootContext;
  };

  /**
   * @ngdoc function
   * @name ui.router.state.$view#load
   * @methodOf ui.router.state.$view
   *
   * @description
   * Uses `$templateFactory` to load a template from a configuration object into a named view.
   *
   * @param {string} name The fully-qualified name of the view to load the template into
   * @param {Object} options The options used to load the template:
   * @param {boolean} options.notify Indicates whether a `$viewContentLoading` event should be
   *    this call.
   * @params {*} options.* Accepts the full list of parameters and options accepted by
   *    `$templateFactory.fromConfig()`, including `params` and `locals`.
   * @return {Promise.<string>} Returns a promise that resolves to the value of the template loaded.
   */
  this.load = function load (viewConfig: ViewConfig, options) {
    options = defaults(options, {
      context:            null,
      parent:             null,
      notify:             true,
      async:              true,
      params:             {}
    });

    if (!viewConfig.hasTemplate())
      throw new Error('No template configuration specified for ' + name);

    if (options.notify) {
      /**
       * @ngdoc event
       * @name ui.router.state.$state#$viewContentLoading
       * @eventOf ui.router.state.$view
       * @eventType broadcast on root scope
       * @description
       *
       * Fired once the view **begins loading**, *before* the DOM is rendered.
       *
       * @param {Object} event Event object.
       * @param {Object} viewConfig The view config properties (template, controller, etc).
       *
       * @example
       *
       * <pre>
       * $scope.$on('$viewContentLoading', function(event, viewConfig) {
       *   // Access to all the view config properties.
       *   // and one special property 'targetView'
       *   // viewConfig.targetView
       * });
       * </pre>
       */
      $rootScope.$broadcast('$viewContentLoading', extend({ targetView: name }, options));
    }

    viewConfig.promises = {
      template: $q.when(viewConfig.getTemplate($templateFactory)),
      controller: $q.when(viewConfig.getController())
    };

    return $q.all(viewConfig.promises).then((results) => {
      debug(`$view.ViewConfig: Loaded ${viewConfigString(viewConfig)}`);
      extend(viewConfig, results);
      this.sync();
    });
  };

  /**
   * Resets a view to its initial state.
   *
   * @param {String} name The fully-qualified name of the view to reset.
   * @return {Boolean} Returns `true` if the view exists, otherwise `false`.
   */
  this.reset = function reset (stateViewConfig) {
    let viewConfig = new ViewConfig(stateViewConfig);
    debug(`$view.ViewConfig: <- Removing ${viewConfigString(viewConfig)}`);
    // TODO: Check if this code is doing the right thing
    viewConfigs.filter(match(viewConfig, "uiViewName", "context")).forEach(removeFrom(viewConfigs));
    //uiViews.filter(match(viewConfig, "name", "parentContext")).forEach(uiView => uiView.configUpdated(null));
  };

  this.registerStateViewConfig = function(stateViewConfig: IStateViewConfig) {
    let viewConfig = new ViewConfig(stateViewConfig);
    debug(`$view.ViewConfig: -> Registering ${viewConfigString(viewConfig)}`);
    viewConfigs.push(viewConfig);
    this.load(viewConfig);
  };

  this.sync = () => {
    let uiViewsByFqn: TypedMap<IUiViewData> =
        uiViews.map(uiv => [uiv.fqn, uiv]).reduce(addPairToObj, <any> {});

    /**
     * Given a ui-view and a ViewConfig, determines if they "match".
     *
     * A ui-view has a fully qualified name (fqn) and a context object.  The fqn is built from its overall location in
     * the DOM, describing its nesting relationship to any parent ui-view tags it is nested inside of.
     *
     * A ViewConfig has a target ui-view name and a context anchor.  The ui-view name can be a simple name, or
     * can be a segmented ui-view path, describing a portion of a ui-view fqn.
     *
     * If the ViewConfig's target ui-view name is a simple name (no dots), then a ui-view matches if:
     * - the ui-view's name matches the ViewConfig's target name
     * - the ui-view's context matches the ViewConfig's anchor
     *
     * If the ViewConfig's target ui-view name is a segmented name (with dots), then a ui-view matches if:
     * - There exists a parent ui-view where:
     *    - the parent ui-view's name matches the first segment (index 0) of the ViewConfig's target name
     *    - the parent ui-view's context matches the ViewConfig's anchor
     * - And the remaining segments (index 1..n) of the ViewConfig's target name match the tail of the ui-view's fqn
     *
     * Example:
     *
     * DOM:
     * <div ui-view>                        <!-- created in the root context (name: "") -->
     *   <div ui-view="foo">                <!-- created in the context named: "A"      -->
     *     <div ui-view>                    <!-- created in the context named: "A.B"    -->
     *       <div ui-view="bar">            <!-- created in the context named: "A.B.C"  -->
     *       </div>
     *     </div>
     *   </div>
     * </div>
     *
     * uiViews: [
     *  { fqn: "$default",                  creationContext: { name: "" } },
     *  { fqn: "$default.foo",              creationContext: { name: "A" } },
     *  { fqn: "$default.foo.$default",     creationContext: { name: "A.B" } }
     *  { fqn: "$default.foo.$default.bar", creationContext: { name: "A.B.C" } }
     * ]
     *
     * These four view configs all match the ui-view with the fqn: "$default.foo.$default.bar":
     *
     * - ViewConfig1: { uiViewName: "bar",                       uiViewContextAnchor: "A.B.C" }
     * - ViewConfig2: { uiViewName: "$default.bar",              uiViewContextAnchor: "A.B" }
     * - ViewConfig3: { uiViewName: "foo.$default.bar",          uiViewContextAnchor: "A" }
     * - ViewConfig4: { uiViewName: "$default.foo.$default.bar", uiViewContextAnchor: "" }
     *
     * Using ViewConfig3 as an example, it matches the ui-view with fqn "$default.foo.$default.bar" because:
     * - The ViewConfig's segmented target name is: [ "foo", "$default", "bar" ]
     * - There exists a parent ui-view (which has fqn: "$default.foo") where:
     *    - the parent ui-view's name "foo" matches the first segment "foo" of the ViewConfig's target name
     *    - the parent ui-view's context "A" matches the ViewConfig's anchor context "A"
     * - And the remaining segments [ "$default", "bar" ].join("."_ of the ViewConfig's target name match
     *   the tail of the ui-view's fqn "default.bar"
     */
    const matches = curry(function(uiView: IUiViewData, viewConfig: ViewConfig) {
      // Split names apart from both viewConfig and uiView into segments
      let vcSegments = viewConfig.uiViewName.split(".");
      let uivSegments = uiView.fqn.split(".");

      // Check if the tails of the segment arrays match. ex, these arrays' tails match:
      // vc: ["foo", "bar"], uiv fqn: ["$default", "foo", "bar"]
      if (!angular.equals(vcSegments, uivSegments.slice(0 - vcSegments.length)))
        return false;

      // Now check if the fqn ending at the first segment of the viewConfig matches the context:
      // ["$default", "foo"].join(".") == "$default.foo", does the ui-view $default.foo context match?
      let negOffset = (1 - vcSegments.length) || undefined;
      let fqnToFirstSegment = uivSegments.slice(0, negOffset).join(".");
      let uiViewContext = uiViewsByFqn[fqnToFirstSegment].creationContext;
      return viewConfig.uiViewContextAnchor === (uiViewContext && uiViewContext.name);
    });

    // Return the number of dots in the fully qualified name
    function uiViewDepth(uiView: IUiViewData) {
      return uiView.fqn.split(".").length;
    }

    // Return the ViewConfig's context's depth in the context tree.
    function viewConfigDepth(config: ViewConfig) {
      let context: IContextRef = config.context, count = 0;
      while (++count && context.parent) context = context.parent;
      return count;
    }

    // Given a depth function, returns a compare function which can return either ascending or descending order
    const depthCompare = curry((depthFn, posNeg, left, right) => posNeg * (depthFn(left) - depthFn(right)));

    const matchingConfigPair = uiView => {
      let matchingConfigs = viewConfigs.filter(matches(uiView));
      if (matchingConfigs.length > 1)
        matchingConfigs.sort(depthCompare(viewConfigDepth, -1)); // descending
      return [uiView, matchingConfigs[0]];
    };

    const configureUiView = ([uiView, viewConfig]) => uiView.configUpdated(viewConfig);
    uiViews.sort(depthCompare(uiViewDepth, 1)).map(matchingConfigPair).forEach(configureUiView);
  };

  /**
   * Allows a `ui-view` element to register its canonical name with a callback that allows it to
   * be updated with a template, controller, and local variables.
   *
   * @param {String} name The fully-qualified name of the `ui-view` object being registered.
   * @param {Function} configUpdatedCallback A callback that receives updates to the content & configuration
   *                   of the view.
   * @return {Function} Returns a de-registration function used when the view is destroyed.
   */
  this.registerUiView = function register(uiView: IUiViewData) {
    debug(`$view.ui-view: -> Registering '${uiView.fqn}' ('${uiView.name}@${uiView.creationContext}')`);
    let fqnMatches = isEq(prop("fqn"), val(uiView.fqn));
    if (uiViews.filter(fqnMatches).length)
      debug(`!!!! duplicate uiView named: '${uiView.fqn}' ('${uiView.name}@${uiView.creationContext}')`);

    uiViews.push(uiView);
    this.sync();

    return () => {
      let idx = uiViews.indexOf(uiView);
      if (idx <= 0) {
        debug("Tried removing non-registered uiView");
        return;
      }
      removeFrom(uiViews)(uiView);
      debug(`$view.ui-view: <- Remove '${uiView.fqn}' from uiViews (new length: ${uiViews.length})`);
    };
  };

  /**
   * Returns the list of views currently available on the page, by fully-qualified name.
   *
   * @return {Array} Returns an array of fully-qualified view names.
   */
  this.available = () => uiViews.map(prop("fqn"));

  /**
   * Returns the list of views on the page containing loaded content.
   *
   * @return {Array} Returns an array of fully-qualified view names.
   */
  this.active = () => uiViews.filter(prop("$config")).map(prop("name"));
}

angular.module('ui.router.state').service('$view', $View);
