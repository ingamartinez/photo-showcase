/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> =
  T | { [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never };
import type { TypedDocumentNode as DocumentNode } from "@graphql-typed-document-node/core";
export type GalleryStatus = "archived" | "delivered" | "draft" | "proofing" | "selected";

export type ClientGalleryListQueryVariables = Exact<{ [key: string]: never }>;

export type ClientGalleryListQuery = {
  galleryList: Array<{
    id: string;
    title: string;
    publicSlug: string;
    status: GalleryStatus;
    sessionDate: string;
    photoCount: number;
    coverProofKey: string | null;
  }>;
};

export type ClientGalleryBySlugQueryVariables = Exact<{
  publicSlug: string;
}>;

export type ClientGalleryBySlugQuery = {
  galleryBySlug: {
    id: string;
    title: string;
    status: GalleryStatus;
    sessionDate: string;
    selectionSubmittedAt: string | null;
    includedPhotosSnapshot: number;
    extraPhotoPriceCopSnapshot: number;
    package: { name: string };
    assets: Array<{
      id: string;
      originalFilename: string;
      proofKey: string;
      proofWidth: number;
      proofHeight: number;
      isSelected: boolean;
      finalKey: string | null;
      isEdited: boolean;
    }>;
  } | null;
};

export const ClientGalleryListDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "ClientGalleryList" },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "galleryList" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "id" } },
                { kind: "Field", name: { kind: "Name", value: "title" } },
                { kind: "Field", name: { kind: "Name", value: "publicSlug" } },
                { kind: "Field", name: { kind: "Name", value: "status" } },
                { kind: "Field", name: { kind: "Name", value: "sessionDate" } },
                { kind: "Field", name: { kind: "Name", value: "photoCount" } },
                { kind: "Field", name: { kind: "Name", value: "coverProofKey" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ClientGalleryListQuery, ClientGalleryListQueryVariables>;
export const ClientGalleryBySlugDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "ClientGalleryBySlug" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "publicSlug" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "galleryBySlug" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "publicSlug" },
                value: { kind: "Variable", name: { kind: "Name", value: "publicSlug" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "id" } },
                { kind: "Field", name: { kind: "Name", value: "title" } },
                { kind: "Field", name: { kind: "Name", value: "status" } },
                { kind: "Field", name: { kind: "Name", value: "sessionDate" } },
                { kind: "Field", name: { kind: "Name", value: "selectionSubmittedAt" } },
                { kind: "Field", name: { kind: "Name", value: "includedPhotosSnapshot" } },
                { kind: "Field", name: { kind: "Name", value: "extraPhotoPriceCopSnapshot" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "package" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [{ kind: "Field", name: { kind: "Name", value: "name" } }],
                  },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "assets" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "originalFilename" } },
                      { kind: "Field", name: { kind: "Name", value: "proofKey" } },
                      { kind: "Field", name: { kind: "Name", value: "proofWidth" } },
                      { kind: "Field", name: { kind: "Name", value: "proofHeight" } },
                      { kind: "Field", name: { kind: "Name", value: "isSelected" } },
                      { kind: "Field", name: { kind: "Name", value: "finalKey" } },
                      { kind: "Field", name: { kind: "Name", value: "isEdited" } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ClientGalleryBySlugQuery, ClientGalleryBySlugQueryVariables>;
