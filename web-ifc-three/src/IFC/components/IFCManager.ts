import * as WebIFC from 'web-ifc';
import { IFCParser } from './IFCParser';
import { SubsetManager } from './SubsetManager';
import { PropertyManager } from './properties/PropertyManager';
import { IfcElements } from './IFCElementsMap';
import { TypeManager } from './TypeManager';
import { HighlightConfigOfModel, IfcState, JSONObject } from '../BaseDefinitions';
import { BufferGeometry, Material, Object3D, Scene } from 'three';
import { IFCModel } from './IFCModel';
import { BvhManager } from './BvhManager';
import { ItemsHider } from './ItemsHider';
import { LoaderSettings } from 'web-ifc';
import { MemoryCleaner } from './MemoryCleaner';
import { IFCWorkerHandler } from '../web-workers/IFCWorkerHandler';
import { PropertyManagerAPI } from './properties/BaseDefinitions';

/**
 * Contains all the logic to work with the loaded IFC files (select, edit, etc).
 */
export class IFCManager {
    private state: IfcState = {
        models: [],
        api: new WebIFC.IfcAPI(),
        useJSON: false,
        worker: { active: false, path: '' }
    };

    private BVH = new BvhManager();
    private parser = new IFCParser(this.state, this.BVH);
    private subsets = new SubsetManager(this.state, this.BVH);
    private properties: PropertyManagerAPI = new PropertyManager(this.state);
    private types = new TypeManager(this.state);
    private hider = new ItemsHider(this.state);
    private cleaner = new MemoryCleaner(this.state);
    private worker?: IFCWorkerHandler;

    async parse(buffer: ArrayBuffer) {
        const model = await this.parser.parse(buffer) as IFCModel;
        model.setIFCManager(this);
        this.state.useJSON ? await this.disposeMemory() : await this.types.getAllTypes(this.worker);
        this.hider.processCoordinates(model.modelID);
        return model;
    }

    getAndClearErrors(modelID: number) {
        return this.parser.getAndClearErrors(modelID);
    }

    /**
     * Sets the relative path of web-ifc.wasm file in the project.
     * Beware: you **must** serve this file in your page; this means
     * that you have to copy this files from *node_modules/web-ifc*
     * to your deployment directory.
     *
     * If you don't use this methods,
     * IFC.js assumes that you are serving it in the root directory.
     *
     * Example if web-ifc.wasm is in dist/wasmDir:
     * `ifcLoader.setWasmPath("dist/wasmDir/");`
     *
     * @path Relative path to web-ifc.wasm.
     */
    setWasmPath(path: string) {
        this.state.api.SetWasmPath(path);
    }

    /**
     * Applies a configuration for [web-ifc](https://ifcjs.github.io/info/docs/Guide/web-ifc/Introduction).
     */
    applyWebIfcConfig(settings: LoaderSettings) {
        this.state.webIfcSettings = settings;
    }

    /**
     * Uses web workers, making the loader non-blocking.
     * @active Wether to use web workers or not.
     * @path Relative path to the web worker file. Necessary if active=true.
     */
    async useWebWorkers(active: boolean, path?: string) {
        if (this.state.worker.active === active) return;
        // @ts-ignore
        this.state.api = null;
        if (active) {
            if (!path) throw new Error('You must provide a path to the web worker.');
            this.state.worker.active = active;
            this.state.worker.path = path;
            await this.initializeWorkers();
        } else {
            this.state.api = new WebIFC.IfcAPI();
        }
    }

    /**
     * Enables the JSON mode (which consumes way less memory) and eliminates the WASM data.
     * Only use this in the following scenarios:
     * - If you don't need to access the properties of the IFC
     * - If you will provide the properties as JSON.
     * @useJSON: Wether to use the JSON mode or not.
     */
    async useJSONData(useJSON = true) {
        this.state.useJSON = useJSON;
        if (useJSON) {
            await this.worker?.workerState.updateStateUseJson();
        }
    }

    /**
     * Adds the properties of a model as JSON data. If you are using web workers, use
     * `loadJsonDataFromWorker()` instead to avoid overheads.
     * @modelID ID of the IFC model.
     * @data: data as an object where the keys are the expressIDs and the values the properties.
     */
    async addModelJSONData(modelID: number, data: { [id: number]: JSONObject }) {
        const model = this.state.models[modelID];
        if (!model) throw new Error('The specified model for the JSON data does not exist');
        if (this.state.worker.active) {
            await this.worker?.workerState.updateModelStateJsonData(modelID, data);
        } else {
            model.jsonData = data;
        }
    }

    /**
     * Loads the data of an IFC model from a JSON file directly from a web worker. If you are not using
     * web workers, use `addModelJSONData()` instead.
     * @modelID ID of the IFC model.
     * @path: the path to the JSON file **relative to the web worker file**.
     */
    async loadJsonDataFromWorker(modelID: number, path: string) {
        if (this.state.worker.active) {
            await this.worker?.workerState.loadJsonDataFromWorker(modelID, path);
        }
    }

    /**
     * Completely releases the WASM memory, thus drastically decreasing the memory use of the app.
     * Only use this in the following scenarios:
     * - If you don't need to access the properties of the IFC
     * - If you will provide the properties as JSON.
     */
    async disposeMemory() {
        if (this.state.worker.active) {
            await this.worker?.Close();
        } else {
            // @ts-ignore
            this.state.api = null;
            this.state.api = new WebIFC.IfcAPI();
        }
    }

    /**
     * Makes object picking a lot faster
     * Courtesy of gkjohnson's [work](https://github.com/gkjohnson/three-mesh-bvh).
     * Import these objects from his library and pass them as arguments. IFC.js takes care of the rest!
     */
    setupThreeMeshBVH(computeBoundsTree: any, disposeBoundsTree: any, acceleratedRaycast: any) {
        this.BVH.initializeMeshBVH(computeBoundsTree, disposeBoundsTree, acceleratedRaycast);
    }

    /**
     * Closes the specified model and deletes it from the [scene](https://threejs.org/docs/#api/en/scenes/Scene).
     * @modelID ID of the IFC model.
     * @scene Scene where the model is (if it's located in a scene).
     */
    close(modelID: number, scene?: Scene) {
        this.state.api.CloseModel(modelID);
        if (scene) scene.remove(this.state.models[modelID].mesh);
        delete this.state.models[modelID];
    }

    /**
     * Gets the **Express ID** to which the given face belongs.
     * This ID uniquely identifies this entity within this IFC file.
     * @geometry The geometry of the IFC model.
     * @faceIndex The index of the face of a geometry.You can easily get this index using the [Raycaster](https://threejs.org/docs/#api/en/core/Raycaster).
     */
    getExpressId(geometry: BufferGeometry, faceIndex: number) {
        return this.properties.getExpressId(geometry, faceIndex);
    }

    /**
     * Returns all items of the specified type. You can import
     * the types from *web-ifc*.
     *
     * Example to get all the standard walls of a project:
     * ```js
     * import { IFCWALLSTANDARDCASE } from 'web-ifc';
     * const walls = ifcLoader.getAllItemsOfType(IFCWALLSTANDARDCASE);
     * ```
     * @modelID ID of the IFC model.
     * @type type of IFC items to get.
     * @verbose If false (default), this only gets IDs. If true, this also gets the native properties of all the fetched items.
     */
    getAllItemsOfType(modelID: number, type: number, verbose: boolean) {
        return this.properties.getAllItemsOfType(modelID, type, verbose);
    }

    /**
     * Gets the native properties of the given element.
     * @modelID ID of the IFC model.
     * @id Express ID of the element.
     * @recursive Wether you want to get the information of the referenced elements recursively.
     */
    getItemProperties(modelID: number, id: number, recursive = false) {
        return this.properties.getItemProperties(modelID, id, recursive);
    }

    /**
     * Gets the [property sets](https://standards.buildingsmart.org/IFC/DEV/IFC4_2/FINAL/HTML/schema/ifckernel/lexical/ifcpropertyset.htm)
     * assigned to the given element.
     * @modelID ID of the IFC model.
     * @id Express ID of the element.
     * @recursive If true, this gets the native properties of the referenced elements recursively.
     */
    getPropertySets(modelID: number, id: number, recursive = false) {
        return this.properties.getPropertySets(modelID, id, recursive);
    }

    /**
     * Gets the properties of the type assigned to the element.
     * For example, if applied to a wall (IfcWall), this would get back the information
     * contained in the IfcWallType assigned to it, if any.
     * @modelID ID of the IFC model.
     * @id Express ID of the element.
     * @recursive If true, this gets the native properties of the referenced elements recursively.
     */
    getTypeProperties(modelID: number, id: number, recursive = false) {
        return this.properties.getTypeProperties(modelID, id, recursive);
    }

    /**
     * Gets the materials assigned to the given element.
     * @modelID ID of the IFC model.
     * @id Express ID of the element.
     * @recursive If true, this gets the native properties of the referenced elements recursively.
     */
    getMaterialsProperties(modelID: number, id: number, recursive = false) {
        return this.properties.getMaterialsProperties(modelID, id, recursive);
    }

    /**
     * Gets the ifc type of the specified item.
     * @modelID ID of the IFC model.
     * @id Express ID of the element.
     */
    getIfcType(modelID: number, id: number) {
        const typeID = this.state.models[modelID].types[id];
        return IfcElements[typeID];
    }

    /**
     * Gets the spatial structure of the project. The
     * [spatial structure](https://standards.buildingsmart.org/IFC/DEV/IFC4_2/FINAL/HTML/schema/ifcproductextension/lexical/ifcspatialstructureelement.htm)
     * is the hierarchical structure that organizes every IFC project (all physical items
     * are referenced to an element of the spatial structure). It is formed by
     * one IfcProject that contains one or more IfcSites, that contain one or more
     * IfcBuildings, that contain one or more IfcBuildingStoreys, that contain
     * one or more IfcSpaces.
     * @modelID ID of the IFC model.
     */
    getSpatialStructure(modelID: number, includeProperties?: boolean) {
        return this.properties.getSpatialStructure(modelID, includeProperties);
    }

    /**
     * Gets the mesh of the subset with the specified [material](https://threejs.org/docs/#api/en/materials/Material).
     * If no material is given, this returns the subset with the original materials.
     * @modelID ID of the IFC model.
     * @material Material assigned to the subset (if any).
     */
    getSubset(modelID: number, material?: Material) {
        return this.subsets.getSubset(modelID, material);
    }

    /**
     * Removes the specified subset.
     * @modelID ID of the IFC model.
     * @parent The parent where the subset is (can be any `THREE.Object3D`).
     * @material Material assigned to the subset, if any.
     */
    removeSubset(modelID: number, parent?: Object3D, material?: Material) {
        this.subsets.removeSubset(modelID, parent, material);
    }

    /**
     * Creates a new geometric subset.
     * @config A configuration object with the following options:
     * - **scene**: `THREE.Object3D` where the model is located.
     * - **modelID**: ID of the model.
     * - **ids**: Express IDs of the items of the model that will conform the subset.
     * - **removePrevious**: wether to remove the previous subset of this model with this material.
     * - **material**: (optional) wether to apply a material to the subset
     */
    createSubset(config: HighlightConfigOfModel) {
        return this.subsets.createSubset(config);
    }

    /**
     * Hides the selected items in the specified model
     * @modelID ID of the IFC model.
     * @ids Express ID of the elements.
     */
    hideItems(modelID: number, ids: number[]) {
        this.hider.hideItems(modelID, ids);
    }

    /**
     * Hides all the items of the specified model
     * @modelID ID of the IFC model.
     */
    hideAllItems(modelID: number) {
        this.hider.hideAllItems(modelID);
    }

    /**
     * Shows all the items of the specified model
     * @modelID ID of the IFC model.
     * @ids Express ID of the elements.
     */
    showItems(modelID: number, ids: number[]) {
        this.hider.showItems(modelID, ids);
    }

    /**
     * Shows all the items of the specified model
     * @modelID ID of the IFC model.
     */
    showAllItems(modelID: number) {
        this.hider.showAllItems(modelID);
    }

    /**
     * Returns the underlying web-ifc API.
     */
    get ifcAPI() {
        return this.state.api;
    }

    /**
     * Deletes all data, releasing all memory
     * Work in progress: this doesn't remove all the memory
     * Page reloading recommended to avoid heap overload
     */
    releaseAllMemory() {
        this.subsets.dispose();
        this.hider.dispose();
        this.cleaner.releaseAllModels();
        // @ts-ignore
        this.state.api = null;
        // @ts-ignore
        this.state.models = null;
        // @ts-ignore
        this.state = null;
    }

    private async initializeWorkers() {
        this.worker = new IFCWorkerHandler(this.state);
        this.state.api = this.worker.webIfc;
        this.properties = this.worker.properties;
        await this.worker.workerState.updateStateUseJson()
    }
}
