// @ts-nocheck
import { LegacyTriangleSplitter } from './LegacyTriangleSplitter';
import { performOperation } from './operations/operations';
import { Brush } from './Brush';
import { GeometryBuilder } from './operations/GeometryBuilder';
import * as GeometryUtils from './operations/GeometryUtils';

// Utility class for performing CSG operations
export class Evaluator {
	triangleSplitter;
	geometryBuilders;
	attributes;
	useGroups;
	consolidateGroups;
	removeUnusedMaterials;

	constructor() {

		this.triangleSplitter = new LegacyTriangleSplitter();
		this.geometryBuilders = [];
		this.attributes = [ 'position', 'uv', 'normal' ];
		this.useGroups = true;
		this.consolidateGroups = true;
		this.removeUnusedMaterials = true;

	}

	getGroupRanges( geometry ) {

		const singleGroup = ! this.useGroups || geometry.groups.length === 0;
		if ( singleGroup ) {

			return [ { start: 0, count: Infinity, materialIndex: 0 } ];

		} else {

			return geometry.groups.map( group => ( { ...group } ) );

		}

	}

	evaluate( a, b, operations, targetBrushes = new Brush() ) {

		let wasArray = true;
		if ( ! Array.isArray( operations ) ) {

			operations = [ operations ];

		}

		if ( ! Array.isArray( targetBrushes ) ) {

			targetBrushes = [ targetBrushes ];
			wasArray = false;

		}

		if ( targetBrushes.length !== operations.length ) {

			throw new Error( 'Evaluator: operations and target array passed as different sizes.' );

		}

		// initialize the geometry fields
		a.prepareGeometry();
		b.prepareGeometry();

		const {
			triangleSplitter,
			geometryBuilders,
			attributes,
			useGroups,
			consolidateGroups,
			removeUnusedMaterials,
		} = this;

		// expand the attribute data array to the necessary size
		while ( geometryBuilders.length < targetBrushes.length ) {

			geometryBuilders.push( new GeometryBuilder() );

		}

		// prepare the attribute data buffer information
		targetBrushes.forEach( ( brush, i ) => {

			geometryBuilders[ i ].initFromGeometry( a.geometry, attributes );
			GeometryUtils.trimAttributes( brush.geometry, attributes );

		} );

		// run the operation to fill the list of attribute data
		performOperation( a, b, operations, triangleSplitter, geometryBuilders, { useGroups } );

		// get the materials and group ranges
		const aGroups = this.getGroupRanges( a.geometry );
		const aMaterials = GeometryUtils.getMaterialList( aGroups, a.material );

		const bGroups = this.getGroupRanges( b.geometry );
		const bMaterials = GeometryUtils.getMaterialList( bGroups, b.material );
		bGroups.forEach( g => g.materialIndex += aMaterials.length );

		// get the full set of groups and materials
		const materials = [ ...aMaterials, ...bMaterials ];
		let groups = [ ...aGroups, ...bGroups ].map( ( group, index ) => ( { ...group, index } ) );

		// adjust the groups
		if ( ! useGroups ) {

			groups = [ { start: 0, count: Infinity, index: 0, materialIndex: 0 } ];

		} else if ( useGroups && consolidateGroups ) {

			// use the same material for any group thats pointing to the same material in different slots
			// so we can merge these groups later
			groups = GeometryUtils.useCommonMaterials( groups, materials );
			groups.sort( ( a, b ) => a.materialIndex - b.materialIndex );

		}

		// apply groups and attribute data to the geometry
		targetBrushes.forEach( ( brush, i ) => {

			const targetGeometry = brush.geometry;
			geometryBuilders[ i ].buildGeometry( targetGeometry, groups );

			// assign brush A's transform to the result so the geometry is in a stable position
			a.matrixWorld.decompose( brush.position, brush.quaternion, brush.scale );
			brush.updateMatrix();
			brush.matrixWorld.copy( a.matrixWorld );

			if ( useGroups ) {

				brush.material = materials;

				if ( consolidateGroups ) {

					GeometryUtils.joinGroups( targetGeometry.groups );

				}

				if ( removeUnusedMaterials ) {

					brush.material = GeometryUtils.removeUnusedMaterials( targetGeometry.groups, materials );

				}

			} else {

				brush.material = materials[ 0 ];

			}

		} );

		return wasArray ? targetBrushes : targetBrushes[ 0 ];

	}

	reset() {

		this.triangleSplitter.reset();

	}

}
